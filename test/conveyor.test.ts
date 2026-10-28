import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { contentHash } from "../src/index/content-hash.ts";
import {
	applyRefresh,
	consumeQueue,
	conveyorTick,
	REFRESH_MS,
	seedSystem,
	type FetchedPage,
} from "../src/index/conveyor.ts";
import type { ItemRecord } from "../src/index/items-rest.ts";
import { refreshDelta, urlsToSeed } from "../src/index/refresh-delta.ts";
import { UrlQueue } from "../src/index/url-queue.ts";
import { admittedUrl } from "../src/crawl/links.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const PRIMER = "https://primer.style/";
const ABOUT = "https://primer.style/about";
const PASTE = "https://paste-dsys.com/";

function queue(): UrlQueue {
	return new UrlQueue(memoryD1());
}

function clock(ms = Date.parse(NOW)): { ms: number } {
	return { ms };
}

function page(status: number, body: string): FetchedPage {
	return { status, body };
}

describe("seed and weekly refresh share one append", () => {
	it("seeding appends that system's sitemap and page links", async () => {
		const pageQueue = queue();
		const primer = seedById("primer");
		const urls = await seedSystem({
			queue: pageQueue,
			seed: primer,
			clock: clock(),
			fetchText: async () =>
				page(
					200,
					"<urlset><url><loc>https://primer.style/about</loc></url><url><loc>https://primer.style/sitemap.xml</loc></url></urlset>",
				),
			fetchPage: async () => page(200, "See [components](https://primer.style/components)"),
		});
		expect(urls).toEqual([PRIMER, ABOUT, "https://primer.style/components"]);
		expect((await pageQueue.list()).map((row) => row.url)).toEqual(urls);
		expect((await pageQueue.list()).every((row) => row.systemId === "primer" && row.op === "fetch")).toBe(true);
	});

	it("appends a weekly diff of new, changed, and deleted pages, and appends nothing when the hash matches", async () => {
		const same = "Same words.";
		const hash = contentHash(same);
		const unchanged = refreshDelta({
			discovered: [PRIMER, ABOUT],
			known: [
				{ url: PRIMER, hash },
				{ url: ABOUT, hash },
			],
			bodies: new Map([
				[PRIMER, same],
				[ABOUT, same],
			]),
		});
		expect(unchanged).toEqual({ fetch: [], delete: [] });

		const pageQueue = queue();
		const applied = await applyRefresh({
			queue: pageQueue,
			systemId: "primer",
			discovered: [PRIMER, ABOUT],
			known: [
				{ url: PRIMER, hash },
				{ url: ABOUT, hash },
			],
			bodies: new Map([
				[PRIMER, same],
				[ABOUT, same],
			]),
			clock: clock(),
		});
		expect(applied.appended).toBe(0);
		expect(await pageQueue.depth()).toBe(0);

		const changed = "Edited words.";
		const delta = refreshDelta({
			discovered: [PRIMER, "https://primer.style/new"],
			known: [
				{ url: PRIMER, hash },
				{ url: ABOUT, hash },
			],
			bodies: new Map([[PRIMER, changed]]),
		});
		expect(delta.fetch).toEqual([PRIMER, "https://primer.style/new"]);
		expect(delta.delete).toEqual([ABOUT]);
		await applyRefresh({
			queue: pageQueue,
			systemId: "primer",
			discovered: [PRIMER, "https://primer.style/new"],
			known: [
				{ url: PRIMER, hash },
				{ url: ABOUT, hash },
			],
			bodies: new Map([[PRIMER, changed]]),
			clock: clock(),
		});
		expect((await pageQueue.list()).map((row) => [row.url, row.op])).toEqual([
			[PRIMER, "fetch"],
			["https://primer.style/new", "fetch"],
			[ABOUT, "delete"],
		]);
	});

	it("admits the same urls urlsToSeed would admit", () => {
		const primer = seedById("primer");
		expect(
			urlsToSeed({
				startUrl: primer.startUrl,
				sitemapLocs: [ABOUT],
				pageLinks: [],
				admit: (url) => admittedUrl(url, primer),
			}),
		).toEqual([PRIMER, ABOUT]);
	});
});

describe("queue consumer", () => {
	it("drains oldest first across systems", async () => {
		const pageQueue = queue();
		const seen: string[] = [];
		await pageQueue.enqueue(
			[
				{ url: PASTE, systemId: "paste", op: "fetch" },
				{ url: PRIMER, systemId: "primer", op: "fetch" },
				{ url: ABOUT, systemId: "primer", op: "fetch" },
			],
			clock(),
		);
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 10,
			clock: clock(Date.parse(NOW) + 10_000),
			knownHashes: new Map(),
			knownUrls: new Set(),
			fetchPage: async (url) => {
				seen.push(url);
				return page(200, `body ${url}`);
			},
			upload: async () => undefined,
			deletePage: async () => undefined,
		});
		expect(seen).toEqual([PASTE, PRIMER, ABOUT]);
		expect(await pageQueue.depth()).toBe(0);
		expect(await pageQueue.errorCount()).toBe(0);
	});

	it("writes no embedding when the hash matches, and uploads when it does not", async () => {
		const pageQueue = queue();
		const same = "unchanged page";
		const hash = contentHash(same);
		await pageQueue.enqueue([{ url: PRIMER, systemId: "primer", op: "fetch" }], clock());
		const uploads: string[] = [];
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 5,
			clock: clock(Date.parse(NOW) + 1000),
			knownHashes: new Map([[`primer\0${PRIMER}`, hash]]),
			knownUrls: new Set([`primer\0${PRIMER}`]),
			fetchPage: async () => page(200, same),
			upload: async () => {
				uploads.push("upload");
			},
			deletePage: async () => undefined,
		});
		expect(uploads).toEqual([]);
		expect(await pageQueue.depth()).toBe(0);

		await pageQueue.enqueue([{ url: ABOUT, systemId: "primer", op: "fetch" }], clock());
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 5,
			clock: clock(Date.parse(NOW) + 2000),
			knownHashes: new Map([[`primer\0${ABOUT}`, hash]]),
			knownUrls: new Set(),
			fetchPage: async () => page(200, "changed page"),
			upload: async (_row, markdown) => {
				uploads.push(markdown);
			},
			deletePage: async () => undefined,
		});
		expect(uploads).toEqual(["changed page"]);
	});

	it("removes a deleted page and a 404, and a failed fetch does not stop the next row", async () => {
		const pageQueue = queue();
		const removed: string[] = [];
		await pageQueue.enqueue(
			[
				{ url: ABOUT, systemId: "primer", op: "delete" },
				{ url: PRIMER, systemId: "primer", op: "fetch" },
				{ url: PASTE, systemId: "paste", op: "fetch" },
			],
			clock(),
		);
		const seen: string[] = [];
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 10,
			clock: clock(Date.parse(NOW) + 5000),
			knownHashes: new Map(),
			knownUrls: new Set(),
			fetchPage: async (url) => {
				seen.push(url);
				if (url === PRIMER) {
					throw new Error("primer down");
				}
				return page(404, "");
			},
			upload: async () => undefined,
			deletePage: async (_systemId, url) => {
				removed.push(url);
			},
		});
		expect(removed).toEqual([ABOUT, PASTE]);
		expect(seen).toEqual([PRIMER, PASTE]);
		const left = await pageQueue.list();
		expect(left.map((row) => row.url)).toEqual([PRIMER]);
		expect(left[0]?.error).toBe("primer down");
		expect(Date.parse(left[0]?.enqueuedAt ?? NOW)).toBeGreaterThan(Date.parse(NOW));
	});

	it("appends a newly found link that is not already known", async () => {
		const pageQueue = queue();
		await pageQueue.enqueue([{ url: PRIMER, systemId: "primer", op: "fetch" }], clock());
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 5,
			clock: clock(Date.parse(NOW) + 1000),
			knownHashes: new Map(),
			knownUrls: new Set([`primer\0${ABOUT}`]),
			fetchPage: async () => page(200, `See [about](${ABOUT}) and [components](https://primer.style/components)`),
			upload: async () => undefined,
			deletePage: async () => undefined,
		});
		expect((await pageQueue.list()).map((row) => row.url)).toEqual(["https://primer.style/components"]);
	});
});

describe("conveyor tick", () => {
	it("seeds every unmarked system on the first tick and drains in FIFO order", async () => {
		const db = memoryD1();
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const fetched: string[] = [];
		const report = await conveyorTick(env, "*/5 * * * *", new Date(NOW), {
			limit: 3,
			listItems: async () => [],
			fetchText: async () => page(404, ""),
			fetchPage: async (url) => {
				fetched.push(url);
				return page(200, `page ${url}`);
			},
			upload: async () => undefined,
			deletePage: async () => undefined,
		});
		expect(fetched.slice(0, 3)).toEqual([
			"https://paste-dsys.com/",
			"https://primer.style/",
			"https://designsystem.digital.gov/",
		]);
		expect(report?.indexed).toBe(3);
		expect(report?.failed).toBe(0);
		expect(report?.depth).toBe(SYSTEM_IDS.length - 3);
		const discover = await db.prepare("SELECT system_id FROM discover_run").first();
		expect(discover).toBeNull();
	});

	it("does not append a weekly refresh when every known page hash matches", async () => {
		const db = memoryD1();
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const body = "stable";
		const hash = contentHash(body);
		const seededAt = new Date(Date.parse(NOW) - REFRESH_MS - 1000).toISOString();
		for (const id of SYSTEM_IDS) {
			await db
				.prepare("INSERT INTO system_mark (system_id, last_discovered, refresh_offset) VALUES (?, ?, 0)")
				.bind(id, seededAt)
				.run();
		}
		const items: ItemRecord[] = SYSTEM_IDS.map((id) => ({
			id: `item-${id}`,
			key: `${id}/page.md`,
			metadata: {
				system: id,
				source_url: seedById(id).startUrl,
				content_hash: hash,
			},
		}));
		const report = await conveyorTick(env, "*/5 * * * *", new Date(NOW), {
			limit: 20,
			listItems: async () => items,
			fetchText: async () => page(404, ""),
			fetchPage: async () => page(200, body),
			upload: async () => {
				throw new Error("unchanged page must not be uploaded");
			},
			deletePage: async () => undefined,
		});
		expect(report?.appended).toBe(0);
		expect(report?.indexed).toBe(0);
		expect(report?.unchanged).toBe(0);
		expect(report?.failed).toBe(0);
		expect(report?.depth).toBe(0);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE error IS NOT NULL").first<{ n: number }>()).toEqual({
			n: 0,
		});
	});
});
