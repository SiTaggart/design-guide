import { createHash } from "node:crypto";
import { INSTANCE_ID, MAX_ITEM_BYTES } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import type { Seed, SystemId } from "../config/types.ts";
import { crawlSeedUrls, type CrawlAuth, type CrawlRecord } from "../crawl/browser-run.ts";
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
	uploaded: number;
	deleted: number;
	keptPrevious: boolean;
	error?: string;
};

function itemKey(system: SystemId, generation: string, pageUrl: string): string {
	const digest = createHash("sha256").update(pageUrl).digest("hex").slice(0, 16);
	return `${system}/${generation}/${digest}.md`;
}

function generationId(now = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
}

async function crawlForSeed(auth: CrawlAuth, seed: Seed): Promise<CrawlRecord[]> {
	const primary = await crawlSeedUrls(auth, seed, seed.startUrls);
	if (primary.length > 0 || !seed.fallbackStartUrls?.length) {
		return primary;
	}
	return crawlSeedUrls(auth, seed, seed.fallbackStartUrls);
}

async function rollbackGeneration(
	auth: ItemsAuth,
	system: SystemId,
	generation: string,
): Promise<void> {
	const prefix = `${system}/${generation}/`;
	const items = await listItems(auth);
	for (const item of items) {
		if (item.key.startsWith(prefix)) {
			await deleteItem(auth, item.id);
		}
	}
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
	const generation = generationId();
	let records: CrawlRecord[] = [];
	try {
		records = await crawlForSeed(auth, seed);
	} catch (error) {
		return {
			system: seed.id,
			uploaded: 0,
			deleted: 0,
			keptPrevious: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const usable = records.filter((record) => {
		const bytes = new TextEncoder().encode(record.markdown ?? "").byteLength;
		return Boolean(record.markdown?.trim()) && bytes <= MAX_ITEM_BYTES;
	});
	if (usable.length === 0) {
		return {
			system: seed.id,
			uploaded: 0,
			deleted: 0,
			keptPrevious: true,
			error: "no usable crawl records",
		};
	}
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
		await rollbackGeneration(itemsAuth, seed.id, generation);
		return {
			system: seed.id,
			uploaded: uploadedKeys.size,
			deleted: 0,
			keptPrevious: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const existing = await listItems(itemsAuth);
	let deleted = 0;
	for (const item of existing) {
		const belongs = item.key.startsWith(`${seed.id}/`);
		const isNew = uploadedKeys.has(item.key);
		if (belongs && !isNew) {
			await deleteItem(itemsAuth, item.id);
			deleted += 1;
		}
	}
	return {
		system: seed.id,
		uploaded: uploadedKeys.size,
		deleted,
		keptPrevious: false,
	};
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
