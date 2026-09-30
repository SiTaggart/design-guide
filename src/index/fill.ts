import { seedById } from "../config/seed.ts";
import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { discoverTick, type DiscoverDeps, type DiscoverTickResult } from "./discover.ts";
import { drainTick, type DrainCounts } from "./drain.ts";
import {
	sendFinishIndexMail,
	sendStartIndexMail,
} from "./mail.ts";
import { readIndexedHashes, writeIndexedHash, writeLastIndexedHashIfComplete } from "./indexed-hashes.ts";
import { D1PageQueue, type QueueDepths } from "./page-queue.ts";
import { systemSeedHash } from "./seed-hash.ts";
import { clearPark, readParks } from "./parks.ts";
import { clearRetrievalHold } from "./retrieval-hold.ts";
import { reindexAuth, isReindexRunning } from "./trigger.ts";
import {
	errorsFromResults,
	countsFrom,
	notifyFailOrPark,
	readStoredStatus,
	writeStatus,
	type IndexTrigger,
} from "./status.ts";
import type { SystemReindexResult } from "./reindex.ts";

const FAIL_MAIL_KEY = "fillFailMail";
const FAIL_MAIL_GAP_MS = 6 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyCounts(): Crawlish {
	return { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 };
}

type Crawlish = SystemReindexResult["crawl"];

export async function fillTick(
	env: WorkerEnv,
	cron: string,
	now = new Date(),
	discoverDeps: Partial<DiscoverDeps> = {},
): Promise<void> {
	if (!env.INDEX || !env.PAGE_QUEUE) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "unbound" }));
		return;
	}
	const auth = reindexAuth(env);
	if (!auth) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "no-auth" }));
		return;
	}
	if (await isReindexRunning(env)) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "running" }));
		return;
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "unread-parks" }));
		return;
	}

	const discover = await discoverTick(env, cron, now, discoverDeps);
	let drain: DrainCounts = { claimed: 0, indexed: 0, failed: 0 };
	let drainError: string | undefined;
	try {
		drain = await drainTick({
			queue: new D1PageQueue(env.PAGE_QUEUE),
			auth,
			now: now.toISOString(),
		});
	} catch (error) {
		drainError = errorMessage(error);
	}
	const queue = new D1PageQueue(env.PAGE_QUEUE);
	await queue.ensure();
	await unparkFilled(env, queue, discover.action === "parked" ? discover.systemId : undefined);
	await noteIndexedSeeds(env, queue, now);
	const depths = await queue.depths();
	await noteFill(env, discover, drain, depths, drainError, now);
	await mailFill(env, discover, drain, depths, drainError, now);
	console.log(
		JSON.stringify({
			event: "index_fill",
			cron,
			discover: discover.action,
			system: "systemId" in discover ? discover.systemId : undefined,
			claimed: drain.claimed,
			indexed: drain.indexed,
			failed: drain.failed,
			depths,
		}),
	);
}

async function unparkFilled(env: WorkerEnv, queue: D1PageQueue, justParked?: SystemId): Promise<void> {
	const parksRead = await readParks(env);
	if (parksRead.kind !== "ok") {
		return;
	}
	const current = await readStoredStatus(env);
	const unparked = new Set(current.unparked ?? []);
	let changed = false;
	for (const row of await queue.freshness()) {
		if (row.system === justParked || row.done < 2 || parksRead.parks[row.system] === undefined) {
			continue;
		}
		await clearPark(env, row.system);
		await clearRetrievalHold(env, row.system);
		unparked.add(row.system);
		changed = true;
	}
	if (!changed) {
		return;
	}
	const parksReadAgain = await readParks(env);
	const parks = parksReadAgain.kind === "ok" ? parksReadAgain.parks : current.parks;
	await writeStatus(env, {
		...current,
		parks,
		unparked: [...unparked],
	});
}

export async function noteIndexedSeeds(env: WorkerEnv, queue: D1PageQueue, now: Date): Promise<void> {
	const indexed = await readIndexedHashes(env);
	const refreshes = await queue.seedRefreshes();
	const running = await queue.running();
	let wrote = false;
	for (const row of await queue.freshness()) {
		if (running?.systemId === row.system) {
			continue;
		}
		const refresh = refreshes[row.system];
		const hash = systemSeedHash(seedById(row.system));
		if (!refresh || refresh.seedHash !== hash) {
			continue;
		}
		if (row.pending > 0 || row.claimed > 0 || row.failed > 0) {
			continue;
		}
		if (!row.lastIndexed || row.lastIndexed < refresh.enqueuedAt) {
			continue;
		}
		if (indexed[row.system] === hash) {
			continue;
		}
		await writeIndexedHash(env, row.system, hash);
		await queue.markDiscovered(row.system, now.toISOString());
		indexed[row.system] = hash;
		wrote = true;
	}
	if (wrote) {
		await writeLastIndexedHashIfComplete(env);
	}
}

function fillOutcome(
	discover: DiscoverTickResult,
	drain: DrainCounts,
	depths: QueueDepths,
	drainError: string | undefined,
): { failed: boolean; reason?: string; stuck: boolean } {
	const stuck = depths.pending === 0 && depths.claimed === 0 && depths.failed > 0 && drain.claimed === 0;
	const noProgress = drain.claimed > 0 && drain.indexed === 0 && drain.failed === drain.claimed;
	if (discover.action === "failed") {
		return { failed: true, reason: discover.error, stuck };
	}
	if (drainError) {
		return { failed: true, reason: drainError, stuck };
	}
	if (noProgress) {
		return { failed: true, reason: "drain made no progress", stuck };
	}
	if (stuck) {
		return { failed: true, reason: "queue stuck", stuck };
	}
	return { failed: false, stuck };
}

async function noteFill(
	env: WorkerEnv,
	discover: DiscoverTickResult,
	drain: DrainCounts,
	depths: QueueDepths,
	drainError: string | undefined,
	now: Date,
): Promise<void> {
	const current = await readStoredStatus(env);
	const outcome = fillOutcome(discover, drain, depths, drainError);
	const busy =
		!outcome.failed &&
		(depths.pending + depths.claimed > 0 || discover.action === "started" || discover.action === "continued");
	if (discover.action === "skip" && drain.claimed === 0 && !drainError && !outcome.stuck) {
		return;
	}
	const trigger = triggerOf(discover) ?? current.trigger;
	const workflowId = workflowOf(discover, now) ?? current.workflowId;
	const runError = outcome.failed ? outcome.reason : undefined;
	const state = outcome.failed ? "fail" : busy ? "running" : "ok";
	const systems =
		discover.action === "enqueued"
			? [
					...current.systems.filter((entry) => entry.system !== discover.systemId),
					resultFor(discover.systemId, seedById(discover.systemId).startUrl, discover.urls),
				]
			: current.systems;
	await writeStatus(env, {
		...current,
		workflowId,
		trigger,
		state,
		startedAt: discover.action === "started" ? now.toISOString() : current.startedAt,
		finishedAt: outcome.failed || !busy ? now.toISOString() : null,
		runError,
		systems,
		errors: errorsFromResults(systems, runError),
		counts: countsFrom(systems, current.parks, runError),
	});
}

function triggerOf(discover: DiscoverTickResult): IndexTrigger | undefined {
	if ("trigger" in discover && discover.trigger) {
		return discover.trigger;
	}
	return undefined;
}

function workflowOf(discover: DiscoverTickResult, now: Date): string | undefined {
	if ("systemId" in discover && discover.systemId && "trigger" in discover && discover.trigger) {
		return `discover-${discover.trigger}-${discover.systemId}`;
	}
	if (discover.action === "failed") {
		return `drain-${now.toISOString()}`;
	}
	return undefined;
}

async function mailFill(
	env: WorkerEnv,
	discover: DiscoverTickResult,
	drain: DrainCounts,
	depths: QueueDepths,
	drainError: string | undefined,
	now: Date,
): Promise<void> {
	try {
		if (discover.action === "started") {
			await sendStartIndexMail(env, {
				trigger: discover.trigger,
				workflowId: `discover-${discover.trigger}-${discover.systemId}`,
				systems: [discover.systemId],
			});
		}
		if (discover.action === "enqueued") {
			const seed = seedById(discover.systemId);
			await sendFinishIndexMail(
				env,
				{ trigger: discover.trigger, workflowId: `discover-${discover.trigger}-${discover.systemId}` },
				[resultFor(discover.systemId, seed.startUrl, discover.urls)],
			);
		}
		if (discover.action === "parked") {
			const seed = seedById(discover.systemId);
			const result: SystemReindexResult = {
				...resultFor(discover.systemId, seed.startUrl, discover.usable),
				parked: true,
				error: `stub: only ${discover.usable} usable page(s)`,
			};
			const document = await readStoredStatus(env);
			await notifyFailOrPark(env, { ...document, systems: [result] }, "park");
			await sendFinishIndexMail(
				env,
				{ trigger: discover.trigger, workflowId: `discover-${discover.trigger}-${discover.systemId}` },
				[result],
			);
		}
		const outcome = fillOutcome(discover, drain, depths, drainError);
		if (outcome.failed && outcome.reason) {
			const reason = outcome.reason;
			if (await failMailDue(env, reason, now)) {
				const system = "systemId" in discover ? discover.systemId : undefined;
				const trigger = triggerOf(discover) ?? "recrawl";
				await sendFinishIndexMail(
					env,
					{ trigger, workflowId: workflowOf(discover, now) ?? `drain-${now.toISOString()}` },
					system ? [failedResult(system, reason)] : [],
					reason,
				);
				await rememberFailMail(env, reason, now);
			}
		}
	} catch (error) {
		console.log(JSON.stringify({ event: "index_mail_failed", phase: "fill", error: errorMessage(error) }));
	}
}

function resultFor(system: SystemId, startUrl: string, usable: number): SystemReindexResult {
	return {
		system,
		startUrl,
		crawl: { ...emptyCounts(), total: usable, finished: usable },
		indexed: 0,
		hitLimit: false,
		keptPrevious: true,
		usable,
	};
}

function failedResult(system: SystemId, error: string): SystemReindexResult {
	const seed = seedById(system);
	return {
		system,
		startUrl: seed.startUrl,
		crawl: emptyCounts(),
		indexed: 0,
		hitLimit: false,
		keptPrevious: true,
		usable: 0,
		error,
	};
}

async function failMailDue(env: WorkerEnv, reason: string, now: Date): Promise<boolean> {
	if (!env.INDEX) {
		return false;
	}
	const raw = await env.INDEX.get(FAIL_MAIL_KEY);
	if (!raw) {
		return true;
	}
	try {
		const previous = JSON.parse(raw) as { reason?: string; at?: string };
		if (
			previous.reason === reason &&
			previous.at &&
			now.getTime() - Date.parse(previous.at) < FAIL_MAIL_GAP_MS
		) {
			return false;
		}
	} catch {
		return true;
	}
	return true;
}

async function rememberFailMail(env: WorkerEnv, reason: string, now: Date): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	await env.INDEX.put(FAIL_MAIL_KEY, JSON.stringify({ reason, at: now.toISOString() }));
}
