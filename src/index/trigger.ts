import { SEEDS } from "../config/seed.ts";
import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { readIndexedHashes, writeIndexedHash, writeLastIndexedHashIfComplete } from "./indexed-hashes.ts";
import { clearPark, liveSystemIds, parkedSystemIds, readParks, writePark, type Parks, type ParksRead } from "./parks.ts";
import { clearRetrievalHold, holdRetrieval } from "./retrieval-hold.ts";
import type { SystemReindexResult } from "./reindex.ts";
import { SEED_HASH, driftedSystems, systemSeedHash } from "./seed-hash.ts";
import {
	isWorkflowLive,
	notifyFailOrPark,
	readStatus,
	recordSystemResult,
	startStatusRun,
	writeStatus,
	type IndexTrigger,
	type ReindexParams,
} from "./status.ts";

export const DRIFT_CRON = "*/5 * * * *";
export const DRIFT_BATCH_LIMIT = 1;

export function driftBatch(systems: readonly SystemId[], read: ParksRead): SystemId[] {
	if (read.kind === "unread") {
		return [];
	}
	const batch: SystemId[] = [];
	for (const id of systems) {
		if (read.parks[id] !== undefined) {
			continue;
		}
		batch.push(id);
		if (batch.length === DRIFT_BATCH_LIMIT) {
			return batch;
		}
	}
	return batch;
}

export const RECRAWL_CRON = "0 4 * * *";
export const RECOVERY_CRON = "0 6 * * SUN";

const RECOVERY_CRON_ALIASES = new Set([RECOVERY_CRON, "0 6 * * 1", "0 6 * * 0"]);

export function isRecoveryCron(cron: string): boolean {
	return RECOVERY_CRON_ALIASES.has(cron);
}

export type TriggerSkipReason = "unbound" | "no-auth" | "running" | "no-drift" | "no-systems" | "unread-parks";

export type TriggerDecision =
	| { action: "skip"; reason: TriggerSkipReason }
	| { action: "start"; trigger: IndexTrigger; systems: SystemId[]; catalogHash: string };

export function reindexAuth(env: WorkerEnv): { accountId: string; apiToken: string } | null {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		return null;
	}
	return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

export function recrawlSystems(parks: Parks): SystemId[] {
	return liveSystemIds(parks);
}

export async function isReindexRunning(env: WorkerEnv): Promise<boolean> {
	if (!env.REINDEX) {
		return false;
	}
	const status = await readStatus(env);
	if (status.state !== "running") {
		return false;
	}
	return isWorkflowLive(env, status.workflowId);
}

export async function decideReindex(env: WorkerEnv, cron: string): Promise<TriggerDecision> {
	if (!env.INDEX || !env.REINDEX) {
		return { action: "skip", reason: "unbound" };
	}
	if (!reindexAuth(env)) {
		return { action: "skip", reason: "no-auth" };
	}
	if (await isReindexRunning(env)) {
		return { action: "skip", reason: "running" };
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		return { action: "skip", reason: "unread-parks" };
	}
	if (cron === DRIFT_CRON) {
		const systems = driftBatch(driftedSystems(await readIndexedHashes(env)), parksRead);
		if (systems.length === 0) {
			return { action: "skip", reason: "no-drift" };
		}
		return { action: "start", trigger: "deploy-drift", systems, catalogHash: SEED_HASH };
	}
	if (cron === RECRAWL_CRON) {
		const systems = recrawlSystems(parksRead.parks);
		if (systems.length === 0) {
			return { action: "skip", reason: "no-systems" };
		}
		return { action: "start", trigger: "recrawl", systems, catalogHash: SEED_HASH };
	}
	if (isRecoveryCron(cron)) {
		const systems = parkedSystemIds(parksRead.parks);
		if (systems.length === 0) {
			return { action: "skip", reason: "no-systems" };
		}
		return { action: "start", trigger: "recovery", systems, catalogHash: SEED_HASH };
	}
	return { action: "skip", reason: "no-systems" };
}

export async function startReindex(
	env: WorkerEnv,
	decision: Extract<TriggerDecision, { action: "start" }>,
): Promise<{ workflowId: string } | { skipped: TriggerSkipReason }> {
	if (!env.REINDEX) {
		return { skipped: "unbound" };
	}
	const workflowId = `reindex-${decision.trigger}-${crypto.randomUUID()}`;
	const params: ReindexParams = {
		trigger: decision.trigger,
		systems: decision.systems,
		catalogHash: decision.catalogHash,
		workflowId,
	};
	const claimed = await startStatusRun(env, { trigger: decision.trigger, workflowId });
	if (claimed.workflowId !== workflowId) {
		return { skipped: "running" };
	}
	try {
		await env.REINDEX.create({ id: workflowId, params });
	} catch (error) {
		const failed = await readStatus(env);
		await writeStatus(env, {
			...failed,
			state: "fail",
			finishedAt: new Date().toISOString(),
		});
		console.log(
			JSON.stringify({
				event: "index_workflow_create_failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
	return { workflowId };
}

export function shouldWriteSeedHash(result: SystemReindexResult): boolean {
	return Boolean(result.parked || result.indexed > 0);
}

export async function persistSystemOutcome(
	env: WorkerEnv,
	result: SystemReindexResult,
): Promise<void> {
	const seed = SEEDS.find((entry) => entry.id === result.system);
	let unparked: SystemId | undefined;
	if (result.parked) {
		await writePark(env, result.system, result.usable ?? 0);
		if (seed) {
			await writeIndexedHash(env, result.system, systemSeedHash(seed));
		}
	} else if (result.indexed > 0) {
		const parksRead = await readParks(env);
		if (parksRead.kind === "ok" && parksRead.parks[result.system] !== undefined) {
			unparked = result.system;
		}
		await clearPark(env, result.system);
		if (seed) {
			await writeIndexedHash(env, result.system, systemSeedHash(seed));
		}
		await clearRetrievalHold(env, result.system);
	}
	if (result.held) {
		await holdRetrieval(env, result.system);
	}
	const document = await recordSystemResult(env, result, unparked);
	if (result.parked) {
		await notifyFailOrPark(env, document, "park");
	} else if (result.error) {
		await notifyFailOrPark(env, document, "fail");
	}
}

export async function commitIndexedHashes(env: WorkerEnv): Promise<void> {
	await writeLastIndexedHashIfComplete(env);
}
