import { createHash } from "node:crypto";
import { CRAWL_LIMIT, INSTANCE_ID, MAX_ITEM_BYTES } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import { isSystemId, type CrawlCounts, type Seed, type SystemId } from "../config/types.ts";
import {
	crawlSeed,
	hitCrawlLimit,
	type CrawlAuth,
	type CrawlOutcome,
	type CrawlRecord,
} from "../crawl/browser-run.ts";
import {
	deleteItem,
	ensureInstance,
	listItems,
	uploadItem,
	type ItemsAuth,
} from "./items-rest.ts";

export type ReindexAuth = CrawlAuth & { instanceId?: string };

export type SystemReindexResult = {
	system: SystemId;
	startUrl: string;
	crawl: CrawlCounts;
	indexed: number;
	hitLimit: boolean;
	keptPrevious: boolean;
	deleted?: number;
	error?: string;
	parked?: boolean;
	usable?: number;
};

const EMPTY_COUNTS: CrawlCounts = { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 };

function itemKey(system: SystemId, generation: string, pageUrl: string): string {
	const digest = createHash("sha256").update(pageUrl).digest("hex").slice(0, 16);
	return `${system}/${generation}/${digest}.md`;
}

function generationId(now = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
}

export function swapGeneration(system: SystemId, durableId?: string, now = new Date()): string {
	if (!durableId) {
		return generationId(now);
	}
	return createHash("sha256").update(`${durableId}\0${system}`).digest("hex").slice(0, 16);
}

function isSystemGenerationKey(key: string, system: SystemId, generation: string): boolean {
	return key.startsWith(`${system}/${generation}/`);
}

export function fitsItem(record: CrawlRecord, seed: Seed): boolean {
	const markdown = record.markdown ?? "";
	if (!markdown.trim() || new TextEncoder().encode(markdown).byteLength > MAX_ITEM_BYTES) {
		return false;
	}
	const suffixes = seed.indexUrlSuffixes;
	if (!suffixes?.length) {
		return true;
	}
	const path = record.url.split("?")[0] ?? "";
	return suffixes.some((suffix) => path.endsWith(suffix));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function deleteItems(auth: ItemsAuth, shouldDelete: (key: string) => boolean): Promise<number> {
	let deleted = 0;
	for (const item of await listItems(auth)) {
		if (shouldDelete(item.key)) {
			await deleteItem(auth, item.id);
			deleted += 1;
		}
	}
	return deleted;
}

export function isDroppedSystemKey(key: string): boolean {
	const prefix = key.split("/")[0] ?? "";
	return prefix !== "" && !isSystemId(prefix);
}

export async function deleteDroppedSystemItems(auth: ItemsAuth): Promise<number> {
	return deleteItems(auth, isDroppedSystemKey);
}

export function reindexFailure(seed: Seed, error: string): SystemReindexResult {
	return {
		system: seed.id,
		startUrl: seed.startUrl,
		crawl: EMPTY_COUNTS,
		indexed: 0,
		hitLimit: false,
		keptPrevious: true,
		usable: 0,
		error,
	};
}

export async function swapFromOutcome(
	auth: ReindexAuth,
	seed: Seed,
	outcome: CrawlOutcome,
	options?: { generation?: string },
): Promise<SystemReindexResult> {
	const itemsAuth: ItemsAuth = {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: auth.instanceId ?? INSTANCE_ID,
	};
	const usable = outcome.records.filter((record) => fitsItem(record, seed));
	const kept: SystemReindexResult = {
		system: seed.id,
		startUrl: outcome.startUrl,
		crawl: outcome.counts,
		indexed: 0,
		hitLimit: hitCrawlLimit(outcome, usable.length),
		keptPrevious: true,
		usable: usable.length,
	};
	if (kept.hitLimit) {
		return { ...kept, error: `crawl hit the ${CRAWL_LIMIT} page limit` };
	}
	if (outcome.status !== "completed") {
		return { ...kept, error: `crawl ended ${outcome.status}` };
	}
	if (isStubGeneration(usable.length)) {
		return { ...kept, parked: true, error: `stub: only ${usable.length} usable page(s)` };
	}
	const generation = options?.generation ?? swapGeneration(seed.id);
	try {
		for (const record of usable) {
			const key = itemKey(seed.id, generation, record.url);
			await uploadItem(itemsAuth, key, record.markdown ?? "", {
				system: seed.id,
				source: seed.source,
				source_url: record.url,
			});
		}
	} catch (error) {
		await deleteItems(itemsAuth, (key) => isSystemGenerationKey(key, seed.id, generation));
		return { ...kept, error: errorMessage(error) };
	}
	const deleted = await deleteItems(
		itemsAuth,
		(key) => key.startsWith(`${seed.id}/`) && !isSystemGenerationKey(key, seed.id, generation),
	);
	return { ...kept, indexed: usable.length, deleted, keptPrevious: false };
}

export async function reindexSystem(
	auth: ReindexAuth,
	seed: Seed,
): Promise<SystemReindexResult> {
	let outcome: CrawlOutcome;
	try {
		outcome = await crawlSeed(auth, seed);
	} catch (error) {
		return reindexFailure(seed, errorMessage(error));
	}
	return swapFromOutcome(auth, seed, outcome);
}

export async function reindex(
	auth: ReindexAuth,
	only?: SystemId,
): Promise<SystemReindexResult[]> {
	const itemsAuth: ItemsAuth = {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: auth.instanceId ?? INSTANCE_ID,
	};
	await ensureInstance(itemsAuth);
	await deleteDroppedSystemItems(itemsAuth);
	const seeds = only ? [seedById(only)] : [...SEEDS];
	const results: SystemReindexResult[] = [];
	for (const seed of seeds) {
		results.push(await reindexSystem(auth, seed));
	}
	return results;
}

export function isStubGeneration(usable: number): boolean {
	return usable < 2;
}

export function reindexExitCode(results: readonly SystemReindexResult[]): 0 | 1 {
	if (results.some((result) => result.hitLimit)) {
		return 1;
	}
	if (results.length > 0 && results.every((result) => result.indexed === 0)) {
		return 1;
	}
	return 0;
}
