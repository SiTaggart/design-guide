import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { SEED_HASH } from "./seed-hash.ts";
import { readParks, type Parks } from "./parks.ts";
import type { SystemReindexResult } from "./reindex.ts";

export const STATUS_KEY = "status";
export const LAST_INDEXED_HASH_KEY = "lastIndexedHash";

export type IndexTrigger = "deploy-drift" | "recrawl" | "recovery";
export type IndexRunState = "running" | "ok" | "fail";
export type IndexErrorChannel = "crawl" | "render" | "index";

export type IndexErrorEntry = {
	system?: SystemId;
	message: string;
};

export type IndexStatusCounts = {
	systems: number;
	indexed: number;
	parked: number;
	errors: number;
};

export type IndexStatusDocument = {
	unbound: boolean;
	workflowId: string | null;
	trigger?: IndexTrigger;
	state?: IndexRunState;
	startedAt?: string;
	finishedAt?: string | null;
	seedHash: string;
	lastIndexedHash: string | null;
	parks: Parks;
	unparked: SystemId[];
	systems: SystemReindexResult[];
	errors: Record<IndexErrorChannel, IndexErrorEntry[]>;
	counts: IndexStatusCounts;
	runError?: string;
};

export type ReindexParams = {
	trigger: IndexTrigger;
	systems: SystemId[];
	catalogHash: string;
	workflowId: string;
};

const EMPTY_ERRORS: Record<IndexErrorChannel, IndexErrorEntry[]> = {
	crawl: [],
	render: [],
	index: [],
};

const LIVE_WORKFLOW = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

export async function isWorkflowLive(
	env: WorkerEnv,
	workflowId: string | null | undefined,
): Promise<boolean> {
	if (!env.REINDEX || !workflowId) {
		return false;
	}
	try {
		const live = await (await env.REINDEX.get(workflowId)).status();
		return LIVE_WORKFLOW.has(live.status);
	} catch {
		return false;
	}
}

export function classifyMessage(error: string): IndexErrorChannel {
	const lowered = error.toLowerCase();
	if (lowered.includes("item ") || lowered.includes("upload") || lowered.includes("instance ")) {
		return "index";
	}
	if (lowered.includes("render")) {
		return "render";
	}
	return "crawl";
}

export function classifyError(result: SystemReindexResult): IndexErrorChannel | null {
	if (result.parked || !result.error) {
		return null;
	}
	return classifyMessage(result.error);
}

export function errorsFromResults(
	results: readonly SystemReindexResult[],
	runError?: string,
): Record<IndexErrorChannel, IndexErrorEntry[]> {
	const errors: Record<IndexErrorChannel, IndexErrorEntry[]> = {
		crawl: [],
		render: [],
		index: [],
	};
	for (const result of results) {
		const channel = classifyError(result);
		if (channel) {
			errors[channel].push({ system: result.system, message: result.error ?? "error" });
		}
	}
	if (runError) {
		errors[classifyMessage(runError)].push({ message: runError });
	}
	return errors;
}

export function countsFrom(
	results: readonly SystemReindexResult[],
	parks: Parks,
	runError?: string,
): IndexStatusCounts {
	const errorCount = Object.values(errorsFromResults(results, runError)).reduce(
		(sum, entries) => sum + entries.length,
		0,
	);
	return {
		systems: results.length,
		indexed: results.reduce((sum, result) => sum + result.indexed, 0),
		parked: Object.keys(parks).length,
		errors: errorCount,
	};
}

export function runStateFrom(results: readonly SystemReindexResult[], runError?: string): IndexRunState {
	if (runError) {
		return "fail";
	}
	return results.some((result) => classifyError(result) !== null) ? "fail" : "ok";
}

export function emptyStatus(unbound: boolean, lastIndexedHash: string | null = null): IndexStatusDocument {
	return {
		unbound,
		workflowId: null,
		seedHash: SEED_HASH,
		lastIndexedHash,
		parks: {},
		unparked: [],
		systems: [],
		errors: { ...EMPTY_ERRORS, crawl: [], render: [], index: [] },
		counts: { systems: 0, indexed: 0, parked: 0, errors: 0 },
	};
}

export async function readLastIndexedHash(env: WorkerEnv): Promise<string | null> {
	if (!env.INDEX) {
		return null;
	}
	return env.INDEX.get(LAST_INDEXED_HASH_KEY);
}

export async function readStatus(env: WorkerEnv): Promise<IndexStatusDocument> {
	if (!env.INDEX) {
		return emptyStatus(true);
	}
	const lastIndexedHash = await readLastIndexedHash(env);
	const parksRead = await readParks(env);
	try {
		const raw = await env.INDEX.get(STATUS_KEY);
		if (!raw) {
			const parks = parksRead.kind === "ok" ? parksRead.parks : {};
			return { ...emptyStatus(false, lastIndexedHash), parks, counts: countsFrom([], parks) };
		}
		const parsed = JSON.parse(raw) as IndexStatusDocument;
		const systems = parsed.systems ?? [];
		const runError = parsed.runError;
		const parks = parksRead.kind === "ok" ? parksRead.parks : (parsed.parks ?? {});
		return {
			...emptyStatus(false, lastIndexedHash),
			...parsed,
			unbound: false,
			lastIndexedHash,
			parks,
			unparked: parsed.unparked ?? [],
			systems,
			runError,
			errors: errorsFromResults(systems, runError),
			counts: countsFrom(systems, parks, runError),
		};
	} catch {
		const parks = parksRead.kind === "ok" ? parksRead.parks : {};
		return { ...emptyStatus(false, lastIndexedHash), parks, counts: countsFrom([], parks) };
	}
}

export async function writeStatus(env: WorkerEnv, document: IndexStatusDocument): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	await env.INDEX.put(STATUS_KEY, JSON.stringify(document));
}

export async function startStatusRun(
	env: WorkerEnv,
	params: Pick<ReindexParams, "trigger" | "workflowId">,
	startedAt = new Date().toISOString(),
): Promise<IndexStatusDocument> {
	const current = await readStatus(env);
	if (
		current.state === "running" &&
		current.workflowId &&
		current.workflowId !== params.workflowId &&
		(await isWorkflowLive(env, current.workflowId))
	) {
		return current;
	}
	const lastIndexedHash = await readLastIndexedHash(env);
	const parksRead = await readParks(env);
	const parks = parksRead.kind === "ok" ? parksRead.parks : current.parks;
	const document: IndexStatusDocument = {
		unbound: false,
		workflowId: params.workflowId,
		trigger: params.trigger,
		state: "running",
		startedAt,
		finishedAt: null,
		seedHash: SEED_HASH,
		lastIndexedHash,
		parks,
		unparked: [],
		systems: [],
		errors: { crawl: [], render: [], index: [] },
		counts: countsFrom([], parks),
		runError: undefined,
	};
	await writeStatus(env, document);
	return document;
}

export async function recordSystemResult(
	env: WorkerEnv,
	result: SystemReindexResult,
	unparked?: SystemId,
): Promise<IndexStatusDocument> {
	const current = await readStatus(env);
	const systems = [...current.systems.filter((entry) => entry.system !== result.system), result];
	const parksRead = await readParks(env);
	const parks = parksRead.kind === "ok" ? parksRead.parks : current.parks;
	const nextUnparked = unparked
		? [...new Set([...(current.unparked ?? []), unparked])]
		: (current.unparked ?? []);
	const document: IndexStatusDocument = {
		...current,
		unbound: false,
		parks,
		unparked: nextUnparked,
		systems,
		errors: errorsFromResults(systems),
		counts: countsFrom(systems, parks),
	};
	await writeStatus(env, document);
	return document;
}

export async function finishStatusRun(
	env: WorkerEnv,
	results: readonly SystemReindexResult[],
	finishedAt = new Date().toISOString(),
	workflowId?: string,
	runError?: string,
): Promise<IndexStatusDocument> {
	const current = await readStatus(env);
	if (
		workflowId &&
		current.workflowId &&
		current.workflowId !== workflowId &&
		(await isWorkflowLive(env, current.workflowId))
	) {
		return current;
	}
	const parksRead = await readParks(env);
	const parks = parksRead.kind === "ok" ? parksRead.parks : current.parks;
	const document: IndexStatusDocument = {
		...current,
		unbound: false,
		workflowId: workflowId ?? current.workflowId,
		state: runStateFrom(results, runError),
		finishedAt,
		lastIndexedHash: await readLastIndexedHash(env),
		parks,
		unparked: current.unparked ?? [],
		systems: [...results],
		runError,
		errors: errorsFromResults(results, runError),
		counts: countsFrom(results, parks, runError),
	};
	await writeStatus(env, document);
	return document;
}

export async function notifyFailOrPark(
	env: WorkerEnv,
	document: IndexStatusDocument,
	kind: "fail" | "park",
): Promise<void> {
	const payload = { event: kind === "park" ? "index_park" : "index_fail", ...document };
	console.log(JSON.stringify(payload));
	if (!env.INDEX_WEBHOOK_URL) {
		return;
	}
	try {
		await fetch(env.INDEX_WEBHOOK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "index_webhook_failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}
