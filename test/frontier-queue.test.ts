import { describe, expect, it } from "vitest";
import { discoverTick } from "../src/index/discover.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

function countingFrontierInserts(db: D1Database): { inserts: () => number } {
	let inserts = 0;
	const prepare = db.prepare.bind(db);
	db.prepare = ((sql: string) => {
		if (sql.includes("INSERT INTO discover_frontier")) {
			inserts += 1;
		}
		return prepare(sql);
	}) as D1Database["prepare"];
	return { inserts: () => inserts };
}

describe("discover frontier writes", () => {
	it("inserts a shared nav once per tick and skips links already collected", async () => {
		const db = memoryD1();
		const counter = countingFrontierInserts(db);
		const pageQueue = new D1PageQueue(db);
		const nav = Array.from({ length: 40 }, (_value, index) => `https://paste-dsys.com/components/nav-${index}`);
		for (let page = 0; page < 25; page += 1) {
			await pageQueue.addFrontier("paste", [...nav, nav[0] ?? ""]);
		}
		expect(counter.inserts()).toBe(1);
		const again = counter.inserts();
		await pageQueue.addFrontier("paste", nav);
		expect(counter.inserts()).toBe(again);
		expect(await pageQueue.nextFrontier("paste", new Set())).toBe("https://paste-dsys.com/components/nav-0");
	});

	it("drops a frontier row outside the seed without fetching it", async () => {
		const outside = "https://www.skyscanner.design/account/billing";
		const inside = "https://www.skyscanner.design/latest/other";
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.insertRun({
			systemId: "backpack",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-backpack",
			startUrl: "https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4",
			cursor: null,
			pollFailures: 0,
			startedAt: "2026-10-18T00:00:00.000Z",
			now: "2026-10-18T00:00:00.000Z",
		});
		await pageQueue.addFrontier("backpack", [outside, inside]);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const fetched: string[] = [];
		await discoverTick(env, "*/5 * * * *", new Date("2026-10-18T00:00:00.000Z"), {
			poll: async () => ({ status: "completed", finished: 0, total: 0 }),
			page: async () => ({ records: [], cursor: null }),
			start: async (_auth, _seed, startUrl) => {
				const url = startUrl ?? "";
				fetched.push(url);
				return { startUrl: url, jobId: "job-next" };
			},
			cancel: async () => undefined,
		});
		const stored = async () => {
			const rows = await db
				.prepare("SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url")
				.bind("backpack")
				.all<{ url: string }>();
			return rows.results?.map((row) => row.url) ?? [];
		};
		expect(fetched).toEqual([inside]);
		expect(await stored()).toEqual([inside]);
		await pageQueue.addFrontier("backpack", [outside]);
		expect(await pageQueue.nextFrontier("backpack", new Set())).toBeNull();
		expect(await stored()).toEqual([inside]);
		expect(await pageQueue.nextFrontier("backpack", new Set())).toBeNull();
		expect(await stored()).toEqual([inside]);
	});

	it("drops out-of-scope frontier rows in one delete and keeps an in-scope row", async () => {
		const outside = [
			"https://www.skyscanner.design/account/a",
			"https://www.skyscanner.design/account/b",
			"https://www.skyscanner.design/account/c",
		];
		const inside = "https://www.skyscanner.design/latest/other";
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.addFrontier("backpack", [...outside, inside]);
		let deletes = 0;
		const prepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			if (sql.startsWith("DELETE FROM discover_frontier")) {
				deletes += 1;
			}
			return prepare(sql);
		}) as D1Database["prepare"];
		const stored = async () => {
			const rows = await db
				.prepare("SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url")
				.bind("backpack")
				.all<{ url: string }>();
			return rows.results?.map((row) => row.url) ?? [];
		};
		expect(await pageQueue.nextFrontier("backpack", new Set())).toBe(inside);
		expect(deletes).toBe(1);
		expect(await stored()).toEqual([inside]);
		deletes = 0;
		expect(await pageQueue.nextFrontier("backpack", new Set([inside]))).toBeNull();
		expect(deletes).toBe(0);
		expect(await stored()).toEqual([inside]);
	});
});
