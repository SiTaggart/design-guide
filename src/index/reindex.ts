import { createHash } from "node:crypto";
import { CRAWL_LIMIT, INSTANCE_ID, MAX_ITEM_BYTES } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import type { CrawlCounts, Seed, SystemId } from "../config/types.ts";
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
};

const EMPTY_COUNTS: CrawlCounts = { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 };

function itemKey(system: SystemId, generation: string, pageUrl: string): string {
	const digest = createHash("sha256").update(pageUrl).digest("hex").slice(0, 16);
	return `${system}/${generation}/${digest}.md`;
}

function generationId(now = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
}

function fitsItem(record: CrawlRecord): boolean {
	const markdown = record.markdown ?? "";
	return Boolean(markdown.trim()) && new TextEncoder().encode(markdown).byteLength <= MAX_ITEM_BYTES;
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

export async function reindexSystem(
	auth: ReindexAuth,
	seed: Seed,
): Promise<SystemReindexResult> {
	const itemsAuth: ItemsAuth = {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: auth.instanceId ?? INSTANCE_ID,
	};
	let outcome: CrawlOutcome;
	try {
		outcome = await crawlSeed(auth, seed);
	} catch (error) {
		return {
			system: seed.id,
			startUrl: seed.startUrl,
			crawl: EMPTY_COUNTS,
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			error: errorMessage(error),
		};
	}
	const usable = outcome.records.filter(fitsItem);
	const kept: SystemReindexResult = {
		system: seed.id,
		startUrl: outcome.startUrl,
		crawl: outcome.counts,
		indexed: 0,
		hitLimit: hitCrawlLimit(outcome, usable.length),
		keptPrevious: true,
	};
	if (kept.hitLimit) {
		return { ...kept, error: `crawl hit the ${CRAWL_LIMIT} page limit` };
	}
	if (outcome.status !== "completed") {
		return { ...kept, error: `crawl ended ${outcome.status}` };
	}
	if (usable.length === 0) {
		return { ...kept, error: "no usable crawl records" };
	}
	const generation = generationId();
	const uploadedKeys = new Set<string>();
	try {
		for (const record of usable) {
			const key = itemKey(seed.id, generation, record.url);
			await uploadItem(itemsAuth, key, record.markdown ?? "", {
				system: seed.id,
				source: seed.source,
				source_url: record.url,
			});
			uploadedKeys.add(key);
		}
	} catch (error) {
		await deleteItems(itemsAuth, (key) => key.startsWith(`${seed.id}/${generation}/`));
		return { ...kept, error: errorMessage(error) };
	}
	const deleted = await deleteItems(
		itemsAuth,
		(key) => key.startsWith(`${seed.id}/`) && !uploadedKeys.has(key),
	);
	return { ...kept, indexed: uploadedKeys.size, deleted, keptPrevious: false };
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
	const seeds = only ? [seedById(only)] : [...SEEDS];
	const results: SystemReindexResult[] = [];
	for (const seed of seeds) {
		results.push(await reindexSystem(auth, seed));
	}
	return results;
}

export function reindexExitCode(results: readonly SystemReindexResult[]): 0 | 1 {
	if (results.some((result) => result.hitLimit)) {
		return 1;
	}
	const web = results.filter((result) => result.system !== "carbon");
	if (web.length > 0 && web.every((result) => result.indexed === 0)) {
		return 1;
	}
	return 0;
}
