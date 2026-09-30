import { createHash } from "node:crypto";
import { INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { Seed, SystemId } from "../config/types.ts";
import { fetchPageMarkdown, type CrawlAuth } from "../crawl/browser-run.ts";
import { deleteItemByKey, ensureInstance, uploadItem, type ItemsAuth } from "./items-rest.ts";
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
	if (item.itemKey && item.itemKey !== key) {
		try {
			await deleteItemByKey(auth, item.itemKey);
		} catch (error) {
			console.log(
				JSON.stringify({
					event: "page_replace_delete_failed",
					system: item.systemId,
					url: item.url,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
	return key;
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
	const indexPage = input.indexPage ?? indexQueuedPage;
	let indexed = 0;
	let failed = 0;
	for (const item of claimed) {
		const timestamps = { lastCrawled: input.now, lastIndexed: input.now };
		try {
			const markdown = await fetchMarkdown(item.url);
			const itemKey = await indexPage(itemsAuth, seedById(item.systemId), item, markdown, timestamps);
			await input.queue.complete(item, timestamps, itemKey);
			indexed += 1;
		} catch (error) {
			await input.queue.fail(item, error instanceof Error ? error.message : String(error));
			failed += 1;
		}
	}
	return { claimed: claimed.length, indexed, failed };
}
