import { SEEDS } from "../config/seed.ts";
import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { readIndexedHashes, writeIndexedHash, writeLastIndexedHashIfComplete } from "./indexed-hashes.ts";
import { clearPark, liveSystemIds, readParks, writePark } from "./parks.ts";
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
export const RECRAWL_CRON = "0 4 * * *";

export type TriggerSkipReason = "unbound" | "no-auth" | "running" | "no-drift" | "no-systems";

export type TriggerDecision =
	| { action: "skip"; reason: TriggerSkipReason }
	| { action: "start"; trigger: IndexTrigger; systems: SystemId[]; catalogHash: string };

export function reindexAuth(env: WorkerEnv): { accountId: string; apiToken: string } | null {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		return null;
	}
	return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

export function recrawlSystems(parks: Awaited<ReturnType<typeof readParks>>): SystemId[] {
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
	if (cron === DRIFT_CRON) {
		const systems = driftedSystems(await readIndexedHashes(env));
		if (systems.length === 0) {
			return { action: "skip", reason: "no-drift" };
		}
		return { action: "start", trigger: "deploy-drift", systems, catalogHash: SEED_HASH };
	}
	if (cron === RECRAWL_CRON) {
		const systems = recrawlSystems(await readParks(env));
		if (systems.length === 0) {
			return { action: "skip", reason: "no-systems" };
		}
		return { action: "start", trigger: "recrawl", systems, catalogHash: SEED_HASH };
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
	await startStatusRun(env, { trigger: decision.trigger, workflowId });
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
	if (result.parked) {
		await writePark(env, result.system, result.usable ?? 0);
		if (seed) {
			await writeIndexedHash(env, result.system, systemSeedHash(seed));
		}
	} else if (result.indexed > 0) {
		await clearPark(env, result.system);
		if (seed) {
			await writeIndexedHash(env, result.system, systemSeedHash(seed));
		}
	}
	const document = await recordSystemResult(env, result);
	if (result.parked) {
		await notifyFailOrPark(env, document, "park");
	} else if (result.error) {
		await notifyFailOrPark(env, document, "fail");
	}
}

export async function commitIndexedHashes(env: WorkerEnv): Promise<void> {
	await writeLastIndexedHashIfComplete(env);
}
