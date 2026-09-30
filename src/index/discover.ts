import { CRAWL_LIMIT, INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { SystemId } from "../config/types.ts";
import {
	CRAWL_POLL_DEADLINE_MS,
	cancelCrawl,
	fetchCrawlPage,
	pollJob,
	startSeedCrawl,
	type CrawlAuth,
} from "../crawl/browser-run.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { readIndexedHashes, writeIndexedHash, writeLastIndexedHashIfComplete } from "./indexed-hashes.ts";
import { deleteItem, deleteItemByKey, listItems, type ItemsAuth } from "./items-rest.ts";
import { parkedSystemIds, readParks, writePark, type Parks } from "./parks.ts";
import { isStubGeneration, fitsItem } from "./reindex.ts";
import { driftedSystems, systemSeedHash } from "./seed-hash.ts";
import { isRecoveryCron } from "./trigger.ts";
import {
	D1PageQueue,
	isDue,
	type DiscoverRun,
	type PageKind,
	type PageQueue,
} from "./page-queue.ts";

export const DISCOVER_URLS_PER_TICK = 25;
const MAX_POLL_FAILURES = 5;

export type DiscoverPick = {
	systemId: SystemId;
	kind: PageKind;
	trigger: "deploy-drift" | "recrawl" | "recovery";
};

export type DiscoverTickResult =
	| { action: "skip"; reason: string }
	| { action: "started"; systemId: SystemId; kind: PageKind; trigger: DiscoverPick["trigger"] }
	| { action: "continued"; systemId: SystemId; accepted: number }
	| {
			action: "enqueued";
			systemId: SystemId;
			kind: PageKind;
			trigger: DiscoverPick["trigger"];
			urls: number;
			pruned: string[];
	  }
	| { action: "parked"; systemId: SystemId; trigger: DiscoverPick["trigger"]; usable: number }
	| { action: "failed"; systemId?: SystemId; trigger?: DiscoverPick["trigger"]; error: string };

type DroppedPage = { url: string; itemKey: string | null };

export function pickDiscoverSystem(input: {
	cron: string;
	drifted: readonly SystemId[];
	due: readonly SystemId[];
	parked: readonly SystemId[];
	parks: Parks;
	busy?: ReadonlySet<SystemId>;
	recoveryAttempts?: Readonly<Record<string, string>>;
}): DiscoverPick | null {
	const busy = input.busy ?? new Set<SystemId>();
	if (isRecoveryCron(input.cron)) {
		const systemId = nextParkedSystem(input.parked, input.recoveryAttempts ?? {});
		if (!systemId) {
			return null;
		}
		return {
			systemId,
			kind: input.drifted.includes(systemId) ? "seed" : "reindex",
			trigger: "recovery",
		};
	}
	const drifted = input.drifted.find((id) => input.parks[id] === undefined && !busy.has(id));
	if (drifted) {
		return { systemId: drifted, kind: "seed", trigger: "deploy-drift" };
	}
	const due = input.due.find((id) => input.parks[id] === undefined);
	if (due) {
		return { systemId: due, kind: "reindex", trigger: "recrawl" };
	}
	return null;
}

export function nextParkedSystem(
	parked: readonly SystemId[],
	attempts: Readonly<Record<string, string>>,
): SystemId | undefined {
	return [...parked].sort((left, right) => {
		const leftAttempt = attempts[left];
		const rightAttempt = attempts[right];
		if (leftAttempt === rightAttempt) {
			return 0;
		}
		if (leftAttempt === undefined) {
			return -1;
		}
		if (rightAttempt === undefined) {
			return 1;
		}
		return leftAttempt < rightAttempt ? -1 : 1;
	})[0];
}

export function dueSystemIds(
	rows: ReadonlyArray<{
		system: SystemId;
		lastIndexed: string | null;
		lastDiscovered: string | null;
		pending: number;
		claimed: number;
	}>,
	now: number,
): SystemId[] {
	return rows
		.filter((row) =>
			isDue({
				lastIndexed: row.lastIndexed,
				lastDiscovered: row.lastDiscovered,
				pending: row.pending + row.claimed,
				now,
			}),
		)
		.sort((left, right) => {
			if (left.lastIndexed === right.lastIndexed) {
				return left.system < right.system ? -1 : 1;
			}
			if (left.lastIndexed === null) {
				return -1;
			}
			if (right.lastIndexed === null) {
				return 1;
			}
			return left.lastIndexed < right.lastIndexed ? -1 : 1;
		})
		.map((row) => row.system);
}

export async function commitDiscoveredUrls(input: {
	queue: PageQueue;
	systemId: SystemId;
	kind: PageKind;
	urls: readonly string[];
	liveUrls?: readonly string[];
	ok: boolean;
	now: string;
	deleteDocs: (dropped: readonly DroppedPage[]) => Promise<void>;
}): Promise<{ pruned: DroppedPage[] }> {
	if (!input.ok) {
		return { pruned: [] };
	}
	const enqueue = [...new Set(input.urls)];
	const live = new Set(input.liveUrls ?? enqueue);
	if (enqueue.length > 0) {
		await input.queue.enqueueUpsert(
			enqueue.map((url) => ({ systemId: input.systemId, url, kind: input.kind })),
			input.now,
		);
	}
	const dropped = await input.queue.listAbsent(input.systemId, live);
	if (dropped.length > 0) {
		await input.deleteDocs(dropped);
		await input.queue.removeUrls(
			input.systemId,
			dropped.map((row) => row.url),
		);
	}
	return { pruned: dropped };
}

export async function deleteOrphanDocs(
	auth: ItemsAuth,
	systemId: SystemId,
	dropped: readonly DroppedPage[],
	liveUrls: ReadonlySet<string> = new Set(),
): Promise<void> {
	const urls = new Set(dropped.map((row) => row.url));
	const keys = new Set(dropped.map((row) => row.itemKey).filter((key): key is string => Boolean(key)));
	const items = await listItems(auth);
	for (const item of items) {
		if (!item.key.startsWith(`${systemId}/`)) {
			continue;
		}
		const sourceUrl = item.metadata?.source_url;
		const metaSystem = item.metadata?.system;
		const systemMatch = metaSystem === undefined || metaSystem === systemId;
		const queuedOrphan = typeof sourceUrl === "string" && urls.has(sourceUrl) && systemMatch;
		const outsideLive =
			liveUrls.size > 0 && typeof sourceUrl === "string" && !liveUrls.has(sourceUrl) && systemMatch;
		if (!queuedOrphan && !outsideLive && !keys.has(item.key)) {
			continue;
		}
		await deleteItem(auth, item.id);
		keys.delete(item.key);
	}
	for (const key of keys) {
		await deleteItemByKey(auth, key);
	}
}

type DiscoverDeps = {
	start: typeof startSeedCrawl;
	poll: typeof pollJob;
	page: typeof fetchCrawlPage;
	cancel: typeof cancelCrawl;
	deleteDocs: typeof deleteOrphanDocs;
};

const defaultDeps: DiscoverDeps = {
	start: startSeedCrawl,
	poll: pollJob,
	page: fetchCrawlPage,
	cancel: cancelCrawl,
	deleteDocs: deleteOrphanDocs,
};

function hitCap(status: string, finished: number): boolean {
	return status === "cancelled_due_to_limits" || finished >= CRAWL_LIMIT;
}

export async function discoverTick(
	env: WorkerEnv,
	cron: string,
	now = new Date(),
	deps: Partial<DiscoverDeps> = {},
): Promise<DiscoverTickResult> {
	try {
		return await runDiscover(env, cron, now, { ...defaultDeps, ...deps });
	} catch (error) {
		return { action: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

async function runDiscover(
	env: WorkerEnv,
	cron: string,
	now: Date,
	deps: DiscoverDeps,
): Promise<DiscoverTickResult> {
	if (!env.PAGE_QUEUE) {
		return { action: "skip", reason: "unbound" };
	}
	const auth = crawlAuth(env);
	if (!auth) {
		return { action: "skip", reason: "no-auth" };
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		return { action: "skip", reason: "unread-parks" };
	}
	const queue = new D1PageQueue(env.PAGE_QUEUE);
	await queue.ensure();
	const running = await queue.running();
	if (running) {
		return continueDiscover(env, queue, auth, running, now, deps);
	}
	const freshness = await queue.freshness();
	const pick = pickDiscoverSystem({
		cron,
		drifted: driftedSystems(await readIndexedHashes(env)),
		due: dueSystemIds(freshness, now.getTime()),
		parked: parkedSystemIds(parksRead.parks),
		parks: parksRead.parks,
		busy: new Set(freshness.filter((row) => row.pending + row.claimed > 0).map((row) => row.system)),
		recoveryAttempts: await queue.recoveryAttempts(),
	});
	if (!pick) {
		return { action: "skip", reason: "idle" };
	}
	const seed = seedById(pick.systemId);
	const iso = now.toISOString();
	if (pick.trigger === "recovery") {
		await queue.noteRecoveryAttempt(pick.systemId, iso);
	}
	let started: { startUrl: string; jobId: string };
	try {
		started = await deps.start(auth, seed);
	} catch (error) {
		return {
			action: "failed",
			systemId: pick.systemId,
			trigger: pick.trigger,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	await queue.insertRun({
		systemId: pick.systemId,
		kind: pick.kind,
		trigger: pick.trigger,
		jobId: started.jobId,
		startUrl: started.startUrl,
		cursor: null,
		pollFailures: 0,
		startedAt: iso,
		now: iso,
	});
	return { action: "started", systemId: pick.systemId, kind: pick.kind, trigger: pick.trigger };
}

async function continueDiscover(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	now: Date,
	deps: DiscoverDeps,
): Promise<DiscoverTickResult> {
	const iso = now.toISOString();
	if (Date.parse(run.startedAt) + CRAWL_POLL_DEADLINE_MS < now.getTime()) {
		return failDiscover(queue, auth, run, deps, "discover timed out");
	}
	let snapshot: { status: string; finished: number };
	try {
		const job = await deps.poll(auth, run.jobId);
		snapshot = {
			status: job.status ?? "unknown",
			finished: typeof job.finished === "number" ? job.finished : 0,
		};
	} catch (error) {
		const failures = await queue.notePollFailure(run.systemId, iso);
		if (failures >= MAX_POLL_FAILURES) {
			return failDiscover(queue, auth, run, deps, error instanceof Error ? error.message : String(error));
		}
		return { action: "continued", systemId: run.systemId, accepted: 0 };
	}
	if (snapshot.status === "running" || snapshot.status === "") {
		return { action: "continued", systemId: run.systemId, accepted: 0 };
	}
	if (hitCap(snapshot.status, snapshot.finished) || snapshot.status !== "completed") {
		return failDiscover(
			queue,
			auth,
			run,
			deps,
			hitCap(snapshot.status, snapshot.finished)
				? `crawl hit the ${CRAWL_LIMIT} page limit`
				: `crawl ended ${snapshot.status}`,
		);
	}
	const seed = seedById(run.systemId);
	let cursor = run.cursor;
	let accepted = 0;
	if (cursor !== "done") {
		try {
			for (let i = 0; i < DISCOVER_URLS_PER_TICK; i += 1) {
				const page = await deps.page(auth, run.jobId, "completed", cursor ?? undefined);
				for (const record of page.records) {
					if (!record.url.startsWith("https://")) {
						continue;
					}
					await queue.stageUrl(run.systemId, record.url);
					if (record.status === "completed" && fitsItem(record, seed)) {
						await queue.stageIndexable(run.systemId, record.url);
						accepted += 1;
					}
				}
				if (page.cursor === null) {
					cursor = "done";
					break;
				}
				cursor = String(page.cursor);
			}
			await queue.saveCursor(run.systemId, cursor, iso);
		} catch (error) {
			const failures = await queue.notePollFailure(run.systemId, iso);
			if (failures >= MAX_POLL_FAILURES) {
				return failDiscover(queue, auth, run, deps, error instanceof Error ? error.message : String(error));
			}
			return { action: "continued", systemId: run.systemId, accepted };
		}
	}
	if (cursor !== "done") {
		return { action: "continued", systemId: run.systemId, accepted };
	}
	const live = await queue.stagedUrls(run.systemId);
	const indexable = await queue.indexableUrls(run.systemId);
	if (isStubGeneration(indexable.length)) {
		await writePark(env, run.systemId, indexable.length, iso);
		await writeIndexedHash(env, run.systemId, systemSeedHash(seed));
		await writeLastIndexedHashIfComplete(env);
		await queue.markDiscovered(run.systemId, iso);
		await queue.clearWork(run.systemId);
		await queue.clearRun(run.systemId);
		return { action: "parked", systemId: run.systemId, trigger: run.trigger, usable: indexable.length };
	}
	const itemsAuth = itemsAuthFrom(env, auth);
	const committed = await commitDiscoveredUrls({
		queue,
		systemId: run.systemId,
		kind: run.kind,
		urls: indexable,
		liveUrls: live,
		ok: true,
		now: iso,
		deleteDocs: (dropped) => deps.deleteDocs(itemsAuth, run.systemId, dropped, new Set(live)),
	});
	await queue.clearRun(run.systemId);
	return {
		action: "enqueued",
		systemId: run.systemId,
		kind: run.kind,
		trigger: run.trigger,
		urls: indexable.length,
		pruned: committed.pruned.map((row) => row.url),
	};
}

async function failDiscover(
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	error: string,
): Promise<DiscoverTickResult> {
	try {
		await deps.cancel(auth, run.jobId);
	} catch (cancelError) {
		console.log(
			JSON.stringify({
				event: "crawl_cancel_failed",
				system: run.systemId,
				error: cancelError instanceof Error ? cancelError.message : String(cancelError),
			}),
		);
	}
	await queue.clearRun(run.systemId);
	return { action: "failed", systemId: run.systemId, trigger: run.trigger, error };
}

function crawlAuth(env: WorkerEnv): CrawlAuth | null {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		return null;
	}
	return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

function itemsAuthFrom(_env: WorkerEnv, auth: CrawlAuth): ItemsAuth {
	return {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: INSTANCE_ID,
	};
}
