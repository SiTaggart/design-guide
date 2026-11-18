import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { isCrawlCapError } from "./crawl-cap.ts";
import {
	D1PageQueue,
	emptyDepths,
	type QueueDepths,
	type SystemFreshness,
} from "./page-queue.ts";
import { readParks, type Parks } from "./parks.ts";
import type { SystemReindexResult } from "./reindex.ts";
import { SEED_HASH } from "./seed-hash.ts";

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

export type IndexDiscoverStatus = {
	systemId: SystemId;
	jobId: string;
	kind: "seed" | "reindex";
	trigger: IndexTrigger;
	startedAt: string;
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
	queue: QueueDepths;
	freshness: SystemFreshness[];
	discover: IndexDiscoverStatus | null;
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
	if (result.parked || !result.error || isCrawlCapError(result.error)) {
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
		queue: emptyDepths(),
		freshness: [],
		discover: null,
	};
}

export async function readLastIndexedHash(env: WorkerEnv): Promise<string | null> {
	if (!env.INDEX) {
		return null;
	}
	return env.INDEX.get(LAST_INDEXED_HASH_KEY);
}

export async function readStoredStatus(env: WorkerEnv): Promise<IndexStatusDocument> {
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
			discover: null,
		};
	} catch {
		const parks = parksRead.kind === "ok" ? parksRead.parks : {};
		return { ...emptyStatus(false, lastIndexedHash), parks, counts: countsFrom([], parks) };
	}
}

export async function readStatus(env: WorkerEnv): Promise<IndexStatusDocument> {
	const stored = await readStoredStatus(env);
	if (!env.PAGE_QUEUE || stored.unbound) {
		console.log(
			JSON.stringify({
				event: "index_status_queue_skip",
				hasQueue: Boolean(env.PAGE_QUEUE),
				unbound: stored.unbound,
			}),
		);
		return stored;
	}
	try {
		const queue = new D1PageQueue(env.PAGE_QUEUE);
		const [depths, freshness] = await Promise.all([queue.depths(), queue.freshness()]);
		return { ...stored, queue: depths, freshness, discover: null };
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "index_status_queue_unread",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return stored;
	}
}

export async function writeStatus(env: WorkerEnv, document: IndexStatusDocument): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	await env.INDEX.put(STATUS_KEY, JSON.stringify(document));
}
