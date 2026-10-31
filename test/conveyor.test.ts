import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { contentHash } from "../src/index/content-hash.ts";
import worker from "../src/worker.ts";
import type { SearchChunk } from "../src/config/types.ts";
import {
	applyRefresh,
	consumeQueue,
	conveyorTick,
	REFRESH_MS,
	seedSystem,
	type FetchedPage,
} from "../src/index/conveyor.ts";
import type { ItemRecord } from "../src/index/items-rest.ts";
import { urlsToSeed } from "../src/index/refresh-delta.ts";
import { UrlQueue } from "../src/index/url-queue.ts";
import { emptyStatus, readStatus, writeStatus } from "../src/index/status.ts";
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
	it("seeding appends the root and the sitemap urls without fetching them", async () => {
		const pageQueue = queue();
		const primer = seedById("primer");
		const urls = await seedSystem({
			queue: pageQueue,
			seed: primer,
			clock: clock(),
		});
		expect(urls).toEqual([
			PRIMER,
			"https://primer.style/robots.txt",
			"https://primer.style/sitemap.xml",
			"https://primer.style/sitemap_index.xml",
		]);
		expect((await pageQueue.list()).map((row) => [row.url, row.op])).toEqual([
			[PRIMER, "fetch"],
			["https://primer.style/robots.txt", "sitemap"],
			["https://primer.style/sitemap.xml", "sitemap"],
			["https://primer.style/sitemap_index.xml", "sitemap"],
		]);
	});

	it("enqueues sitemap rows and every known page, and does not delete a page the sitemap omitted", async () => {
		const pageQueue = queue();
		const appended = await applyRefresh({
			queue: pageQueue,
			systemId: "primer",
			seed: seedById("primer"),
			known: [PRIMER, ABOUT],
			clock: clock(),
		});
		expect(appended).toBe(5);
		expect((await pageQueue.list()).map((row) => [row.url, row.op])).toEqual([
			["https://primer.style/robots.txt", "sitemap"],
			["https://primer.style/sitemap.xml", "sitemap"],
			["https://primer.style/sitemap_index.xml", "sitemap"],
			[PRIMER, "fetch"],
			[ABOUT, "fetch"],
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

	it("keeps the row when deleting the old copy fails, including a matching hash", async () => {
		const pageQueue = queue();
		const same = "unchanged page";
		const hash = contentHash(same);
		await pageQueue.enqueue(
			[
				{ url: PRIMER, systemId: "primer", op: "fetch" },
				{ url: ABOUT, systemId: "primer", op: "fetch" },
			],
			clock(),
		);
		const uploads: string[] = [];
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 1,
			clock: clock(Date.parse(NOW) + 60_000),
			knownHashes: new Map([[`primer\0${PRIMER}`, hash]]),
			knownUrls: new Set([`primer\0${PRIMER}`]),
			fetchPage: async () => page(200, same),
			upload: async () => {
				uploads.push("upload");
			},
			deletePage: async () => undefined,
			retain: async () => {
				throw new Error("old copy delete failed");
			},
		});
		expect(uploads).toEqual([]);
		const afterMatch = await pageQueue.list();
		const matching = afterMatch.find((row) => row.url === PRIMER);
		const stillQueued = afterMatch.find((row) => row.url === ABOUT);
		expect(matching?.error).toBe("old copy delete failed");
		expect(Date.parse(matching?.enqueuedAt ?? NOW)).toBeGreaterThan(Date.parse(stillQueued?.enqueuedAt ?? NOW));

		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 1,
			clock: clock(Date.parse(NOW) + 120_000),
			knownHashes: new Map([[`primer\0${ABOUT}`, "previous"]]),
			knownUrls: new Set([`primer\0${ABOUT}`]),
			fetchPage: async (url) => page(200, url === ABOUT ? "changed page" : same),
			upload: async (_row, markdown) => {
				uploads.push(markdown);
			},
			deletePage: async () => undefined,
			retain: async () => {
				throw new Error("old copy delete failed");
			},
		});
		expect(uploads).toEqual(["changed page"]);
		const changed = (await pageQueue.list()).find((row) => row.url === ABOUT);
		expect(changed?.error).toBe("old copy delete failed");
		expect(await pageQueue.depth()).toBe(2);
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

	it("drains a sitemap cycle across ticks", async () => {
		const pageQueue = queue();
		const indexA = "https://primer.style/sitemap-a.xml";
		const indexB = "https://primer.style/sitemap-b.xml";
		await pageQueue.enqueue([{ url: indexA, systemId: "primer", op: "sitemap" }], clock());
		const fetched: string[] = [];
		const shared = clock(Date.parse(NOW) + 60_000);
		for (let tick = 0; tick < 4; tick += 1) {
			await consumeQueue({
				queue: pageQueue,
				now: NOW,
				limit: 1,
				clock: shared,
				knownHashes: new Map(),
				knownUrls: new Set(),
				fetchText: async (url) => {
					fetched.push(url);
					const child = url === indexA ? indexB : indexA;
					return page(200, `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`);
				},
				fetchPage: async () => page(404, ""),
				upload: async () => undefined,
				deletePage: async () => undefined,
			});
		}
		expect(fetched).toEqual([indexA, indexB]);
		expect(await pageQueue.depth()).toBe(0);
	});

	it("hides a stale copy when deleting it fails and keeps the queue row", async () => {
		const db = memoryD1();
		const pageQueue = new UrlQueue(db);
		const body = "current copy of the page";
		const hash = contentHash(body);
		await pageQueue.enqueue([{ url: PRIMER, systemId: "primer", op: "fetch" }], clock());
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 1,
			clock: clock(Date.parse(NOW) + 60_000),
			knownHashes: new Map([[`primer\0${PRIMER}`, hash]]),
			knownUrls: new Set([`primer\0${PRIMER}`]),
			fetchPage: async () => page(200, body),
			upload: async () => {
				throw new Error("must not upload");
			},
			deletePage: async () => undefined,
			retain: async () => {
				throw new Error("old copy delete failed");
			},
		});
		const left = await pageQueue.list();
		expect(left.map((row) => row.url)).toEqual([PRIMER]);
		expect(left[0]?.error).toBe("old copy delete failed");
		const stale: SearchChunk = {
			text: "stale copy of the page",
			score: 1,
			scoring_details: { vector_score: 0.91 },
			item: {
				key: "primer/page/stale.md",
				metadata: { system: "primer", source: "Primer", source_url: PRIMER, content_hash: "old-hash" },
			},
		};
		const current: SearchChunk = {
			text: body,
			score: 1,
			scoring_details: { vector_score: 0.72 },
			item: {
				key: "primer/page/current.md",
				metadata: { system: "primer", source: "Primer", source_url: PRIMER, content_hash: hash },
			},
		};
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "copy of the page" }),
			}),
			{
				AI_SEARCH: {
					get: () => ({
						search: async () => ({ chunks: [stale, current] }),
						items: { list: async () => ({ result: [{ status: "completed" }] }) },
					}),
				},
				PAGE_QUEUE: db,
			},
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { results: Array<{ passage: string }> };
		expect(payload.results.map((hit) => hit.passage)).toEqual([body]);
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
		expect(fetched).toEqual(["https://paste-dsys.com/"]);
		expect(report?.indexed).toBe(1);
		expect(report?.deleted).toBe(0);
		expect(report?.failed).toBe(0);
		expect(report?.depth).toBe(SYSTEM_IDS.length * 4 - 3);
		expect((await new UrlQueue(db).list()).some((row) => row.op === "sitemap")).toBe(true);
		const discover = await db.prepare("SELECT system_id FROM discover_run").first();
		expect(discover).toBeNull();
	});

	it("enqueues every known page on a weekly refresh, and an unchanged page uploads nothing", async () => {
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
			await db.prepare("INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)").bind(id, seededAt).run();
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
		const pageFetches: string[] = [];
		const deleted: string[] = [];
		const report = await conveyorTick(env, "*/5 * * * *", new Date(NOW), {
			limit: 80,
			listItems: async () => items,
			fetchText: async () => page(404, ""),
			fetchPage: async (url) => {
				pageFetches.push(url);
				return page(200, body);
			},
			upload: async () => {
				throw new Error("unchanged page must not be uploaded");
			},
			deletePage: async (_systemId, url) => {
				deleted.push(url);
			},
		});
		expect(pageFetches.length).toBe(SYSTEM_IDS.length);
		expect(deleted).toEqual([]);
		expect(report?.indexed).toBe(0);
		expect(report?.unchanged).toBe(SYSTEM_IDS.length);
		expect(report?.failed).toBe(0);
		expect(report?.deleted).toBe(0);
		expect(report?.depth).toBe(0);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM queue WHERE error IS NOT NULL").first<{ n: number }>()).toEqual({
			n: 0,
		});
	});

	it("continues a sitemap across ticks while a queued page still drains", async () => {
		const db = memoryD1();
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await db.prepare("INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)").bind(id, NOW).run();
		}
		const pageQueue = new UrlQueue(db);
		const indexUrl = "https://primer.style/sitemap_index.xml";
		const childA = "https://primer.style/sitemap-a.xml";
		const childB = "https://primer.style/sitemap-b.xml";
		const pageB = "https://primer.style/components";
		await pageQueue.enqueue(
			[
				{ url: ABOUT, systemId: "primer", op: "fetch" },
				{ url: indexUrl, systemId: "primer", op: "sitemap" },
				{ url: pageB, systemId: "primer", op: "fetch" },
			],
			clock(Date.parse(NOW) - 60_000),
		);
		const textCalls: string[] = [];
		const pageCalls: string[] = [];
		const deps = {
			limit: 1,
			listItems: async (): Promise<ItemRecord[]> => [],
			fetchText: async (url: string) => {
				textCalls.push(url);
				if (url === indexUrl) {
					return page(
						200,
						`<sitemapindex><sitemap><loc>${childA}</loc></sitemap><sitemap><loc>${childB}</loc></sitemap></sitemapindex>`,
					);
				}
				if (url === childA) {
					return page(200, `<urlset><url><loc>${ABOUT}</loc></url></urlset>`);
				}
				return page(404, "");
			},
			fetchPage: async (url: string) => {
				pageCalls.push(url);
				return page(200, `body ${url}`);
			},
			upload: async () => undefined,
			deletePage: async () => undefined,
		};
		const tick = (offsetMs: number) => conveyorTick(env, "*/5 * * * *", new Date(Date.parse(NOW) + offsetMs), deps);

		const first = await tick(0);
		expect(pageCalls).toEqual([ABOUT]);
		expect(textCalls).toEqual([]);
		expect(first?.indexed).toBe(1);
		expect((await pageQueue.list()).map((row) => row.url)).toEqual([indexUrl, pageB]);

		await tick(60_000);
		expect(textCalls).toEqual([indexUrl]);
		expect(pageCalls).toEqual([ABOUT]);
		expect((await pageQueue.list()).map((row) => row.url)).toEqual([pageB, childA, childB]);

		const third = await tick(120_000);
		expect(pageCalls).toEqual([ABOUT, pageB]);
		expect(textCalls).toEqual([indexUrl]);
		expect(third?.indexed).toBe(1);
		expect((await pageQueue.list()).map((row) => row.url)).toEqual([childA, childB]);

		await tick(180_000);
		expect(textCalls).toEqual([indexUrl, childA]);
		expect((await pageQueue.list()).map((row) => row.url)).toEqual([childB, ABOUT]);
	});

	it("crawls pending page_work that discover already marked, and clears the abandoned slot", async () => {
		const db = memoryD1();
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await db.prepare("INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)").bind(id, NOW).run();
		}
		await db
			.prepare(
				"INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts) VALUES (?, ?, 'seed', 'pending', ?, 0)",
			)
			.bind("primer", ABOUT, "2026-10-29T17:00:00.000Z")
			.run();
		await db
			.prepare(
				`INSERT INTO discover_run (
				   system_id, kind, trigger_name, job_id, start_url, poll_failures, started_at, updated_at
				 ) VALUES (?, 'seed', 'deploy-drift', 'job-patternfly', 'https://www.patternfly.org/', 0, ?, ?)`,
			)
			.bind("patternfly", "2026-10-29T17:20:00.000Z", "2026-10-29T17:20:00.000Z")
			.run();
		await writeStatus(env, {
			...emptyStatus(false),
			workflowId: "discover-deploy-drift-patternfly",
			trigger: "deploy-drift",
			state: "running",
			startedAt: "2026-10-19T17:00:00.000Z",
			finishedAt: null,
		});
		const fetched: string[] = [];
		const report = await conveyorTick(env, "*/5 * * * *", new Date(NOW), {
			limit: 5,
			listItems: async () => [],
			fetchText: async () => page(404, ""),
			fetchPage: async (url) => {
				fetched.push(url);
				return page(200, `body ${url}`);
			},
			upload: async () => undefined,
			deletePage: async () => undefined,
		});
		const status = await readStatus(env);
		const primer = status.freshness.find((row) => row.system === "primer");
		expect(fetched).toContain(ABOUT);
		expect(report?.failed).toBe(0);
		expect(status.queue).toMatchObject({ pending: 0, claimed: 0, failed: 0 });
		expect(primer).toMatchObject({ pending: 0, lastCrawled: NOW });
		expect(status.discover).toBeNull();
		expect(status.state).toBe("ok");
	});
});
