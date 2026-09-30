import { createHash } from "node:crypto";
import { INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { Seed, SystemId } from "../config/types.ts";
import { fetchPageMarkdown, type CrawlAuth } from "../crawl/browser-run.ts";
import {
	deleteItem,
	deleteItemByKey,
	ensureInstance,
	listItems,
	uploadItem,
	type ItemRecord,
	type ItemsAuth,
} from "./items-rest.ts";
import { DRAIN_LIMIT, type PageQueue, type PageWorkItem } from "./page-queue.ts";
import { fitsItem } from "./reindex.ts";

export type DrainCounts = {
	claimed: number;
	indexed: number;
	failed: number;
};

export function pageItemKey(system: SystemId, url: string, attempts: number, stamp: string): string {
	const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
	const slot = createHash("sha256").update(`${attempts}\0${stamp}`).digest("hex").slice(0, 8);
	return `${system}/page/${digest}-${slot}.md`;
}

export async function indexQueuedPage(
	auth: ItemsAuth,
	seed: Seed,
	item: PageWorkItem,
	markdown: string,
	timestamps: { lastCrawled: string; lastIndexed: string },
	catalog?: { items: ItemRecord[] | null },
): Promise<string> {
	if (!fitsItem({ url: item.url, status: "completed", markdown }, seed)) {
		throw new Error("page is not indexable");
	}
	const key = pageItemKey(item.systemId, item.url, item.attempts, timestamps.lastIndexed);
	await uploadItem(auth, key, markdown, {
		system: seed.id,
		source: seed.source,
		source_url: item.url,
		lastCrawled: timestamps.lastCrawled,
		lastIndexed: timestamps.lastIndexed,
	});
	await deleteReplacedItems(auth, item.systemId, item.url, key, item.itemKey, catalog);
	return key;
}

async function deleteReplacedItems(
	auth: ItemsAuth,
	systemId: SystemId,
	url: string,
	keepKey: string,
	previousKey: string | null,
	catalog?: { items: ItemRecord[] | null },
): Promise<void> {
	const pendingKeys = new Set<string>();
	if (previousKey && previousKey !== keepKey) {
		pendingKeys.add(previousKey);
	}
	let items: ItemRecord[] = [];
	try {
		if (catalog?.items) {
			items = catalog.items;
		} else {
			items = await listItems(auth);
			if (catalog) {
				catalog.items = items;
			}
		}
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "page_replace_list_failed",
				system: systemId,
				url,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	for (const found of items) {
		if (found.key === keepKey || !found.key.startsWith(`${systemId}/`)) {
			continue;
		}
		const sourceUrl = found.metadata?.source_url;
		const metaSystem = found.metadata?.system;
		const sameSystem = metaSystem === undefined || metaSystem === systemId;
		if (sourceUrl !== url || !sameSystem) {
			continue;
		}
		pendingKeys.add(found.key);
		try {
			await deleteItem(auth, found.id);
			pendingKeys.delete(found.key);
		} catch (error) {
			console.log(
				JSON.stringify({
					event: "page_replace_delete_failed",
					system: systemId,
					url,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
	for (const key of pendingKeys) {
		try {
			await deleteItemByKey(auth, key);
		} catch (error) {
			console.log(
				JSON.stringify({
					event: "page_replace_delete_failed",
					system: systemId,
					url,
					key,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
}

export async function drainTick(input: {
	queue: PageQueue;
	auth: CrawlAuth;
	now: string;
	limit?: number;
	fetchMarkdown?: (url: string) => Promise<string>;
	indexPage?: typeof indexQueuedPage;
}): Promise<DrainCounts> {
	const itemsAuth: ItemsAuth = { ...input.auth, instanceId: INSTANCE_ID };
	const claimed = await input.queue.claim(input.limit ?? DRAIN_LIMIT, input.now);
	if (claimed.length === 0) {
		return { claimed: 0, indexed: 0, failed: 0 };
	}
	await ensureInstance(itemsAuth);
	const fetchMarkdown = input.fetchMarkdown ?? ((url: string) => fetchPageMarkdown(input.auth, url));
	const catalog: { items: ItemRecord[] | null } = { items: null };
	const indexPage =
		input.indexPage ??
		((auth, seed, item, markdown, timestamps) =>
			indexQueuedPage(auth, seed, item, markdown, timestamps, catalog));
	let indexed = 0;
	let failed = 0;
	for (const item of claimed) {
		const timestamps = { lastCrawled: input.now, lastIndexed: input.now };
		try {
			const markdown = await fetchMarkdown(item.url);
			const itemKey = await indexPage(itemsAuth, seedById(item.systemId), item, markdown, timestamps);
			if (await input.queue.complete(item, timestamps, itemKey)) {
				indexed += 1;
			}
		} catch (error) {
			if (await input.queue.fail(item, error instanceof Error ? error.message : String(error))) {
				failed += 1;
			}
		}
	}
	return { claimed: claimed.length, indexed, failed };
}
