import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverTick } from "../src/index/discover.ts";
import { drainTick } from "../src/index/drain.ts";
import * as itemsRest from "../src/index/items-rest.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const DRIFT_CRON = "*/5 * * * *";
const CANONICAL = "https://www.skyscanner.design/latest/real";
const ALSO = "https://www.skyscanner.design/latest/other";
const OFF_HOST = "https://gitlab.com/other-group/other-project";
const LINK_LOCAL = "https://169.254.169.254/latest/meta-data/";
const USERINFO = "https://user@other.example/latest/page";
const OFF_PATTERN = "https://www.skyscanner.design/account/billing";
const QUERY_VARIANTS = [
	`${CANONICAL}?dup=1`,
	`${CANONICAL}?dup=2`,
	`${CANONICAL}?next=${encodeURIComponent(LINK_LOCAL)}`,
];

afterEach(() => {
	vi.restoreAllMocks();
});

async function workUrls(db: D1Database, systemId: string): Promise<string[]> {
	const rows = await db
		.prepare("SELECT url FROM page_work WHERE system_id = ? ORDER BY url")
		.bind(systemId)
		.all<{ url: string }>();
	return (rows.results ?? []).map((row) => row.url);
}

describe("discovered records stay inside the seed", () => {
	it("drops records outside the seed, collapses query variants, and does not fetch or upload the rest", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "backpack",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-backpack",
			startUrl: "https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const records = [OFF_HOST, LINK_LOCAL, USERINFO, OFF_PATTERN, ALSO, ...QUERY_VARIANTS].map((url) => ({
			url,
			status: "completed",
			markdown: "# guidance",
		}));
		await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: records.length, total: records.length }),
			page: async () => ({ records, cursor: null }),
			start: async () => {
				throw new Error("no follow-up crawl");
			},
			cancel: async () => undefined,
		});
		const rows = await workUrls(db, "backpack");
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		const fetched: string[] = [];
		const uploaded: string[] = [];
		const drained = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async (url) => {
				fetched.push(url);
				return "# guidance";
			},
			indexPage: async (_auth, _seed, item) => {
				uploaded.push(item.url);
				return "backpack/page/real.md";
			},
		});
		const kept = [ALSO, CANONICAL];
		expect({
			rows,
			fetched: [...fetched].sort(),
			uploaded: [...uploaded].sort(),
			failed: drained.failed,
		}).toEqual({
			rows: kept,
			fetched: kept,
			uploaded: kept,
			failed: 0,
		});
	});

	it("fails a queued row outside the seed instead of fetching it", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const allowed = "https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4";
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: LINK_LOCAL, kind: "seed" },
				{ systemId: "backpack", url: allowed, kind: "seed" },
			],
			NOW,
		);
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		const fetched: string[] = [];
		const drained = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async (url) => {
				fetched.push(url);
				return "# guidance";
			},
			indexPage: async () => "backpack/page/welcome.md",
		});
		const rejected = await db
			.prepare("SELECT status, error FROM page_work WHERE system_id = ? AND url = ?")
			.bind("backpack", LINK_LOCAL)
			.first<{ status: string; error: string | null }>();
		expect(fetched).toEqual([allowed]);
		expect(rejected).toMatchObject({ status: "failed", error: "url outside seed scope" });
		expect(drained.failed).toBe(1);
		expect(drained.indexed).toBe(1);
	});

	it("fetches a queued row when its canonical form is inside the seed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const slash = "https://www.skyscanner.design/latest/real/";
		const query = "https://www.skyscanner.design/latest/real?view=1";
		const outside = "https://www.skyscanner.design/account/billing";
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: slash, kind: "seed" },
				{ systemId: "backpack", url: query, kind: "seed" },
				{ systemId: "backpack", url: outside, kind: "seed" },
			],
			NOW,
		);
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		const fetched: string[] = [];
		const uploaded: string[] = [];
		const drained = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async (url) => {
				fetched.push(url);
				return "# guidance";
			},
			indexPage: async (_auth, _seed, item) => {
				uploaded.push(item.url);
				return "backpack/page/real.md";
			},
		});
		const kept = [query, slash].sort();
		const rejected = await db
			.prepare("SELECT status, error FROM page_work WHERE system_id = ? AND url = ?")
			.bind("backpack", outside)
			.first<{ status: string; error: string | null }>();
		expect([...fetched].sort()).toEqual(kept);
		expect([...uploaded].sort()).toEqual(kept);
		expect(rejected).toMatchObject({ status: "failed", error: "url outside seed scope" });
		expect(drained.failed).toBe(1);
		expect(drained.indexed).toBe(2);
	});
});
