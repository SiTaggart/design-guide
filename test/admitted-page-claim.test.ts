import { afterEach, describe, expect, it, vi } from "vitest";
import { drainTick } from "../src/index/drain.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { memoryD1, stampClaim } from "./helpers/d1.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const LATER = "2026-10-18T00:05:00.000Z";
const LATEST = "2026-10-18T00:10:00.000Z";
const EXPIRED = "2026-10-18T00:16:00.000Z";
const CANONICAL = "https://www.skyscanner.design/latest/real";
const SLASH = `${CANONICAL}/`;
const QUERY = `${CANONICAL}?view=1`;
const PRIOR = "backpack/page/prior.md";
const AUTH = { accountId: "acct", apiToken: "token" };

type Stored = { id: string; key: string; body: string; metadata: Record<string, string> };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function catalog(items: Stored[], afterInsert: () => Promise<void>) {
	let ids = 0;
	return vi.fn(async (input: string | URL, init?: RequestInit) => {
		const target = new URL(typeof input === "string" ? input : input.toString());
		const method = init?.method ?? "GET";
		if (method === "GET" && target.pathname.endsWith("/instances/design-guide")) {
			return json(200, { result: { id: "design-guide" } });
		}
		if (method === "POST" && target.pathname.endsWith("/items")) {
			const form = init?.body as FormData;
			const file = form.get("file") as File;
			if (items.some((item) => item.key === file.name)) {
				return json(409, { errors: [{ code: 7042, message: "item_key_already_exist" }] });
			}
			const id = `id-${(ids += 1)}`;
			items.push({
				id,
				key: file.name,
				body: await file.text(),
				metadata: JSON.parse(String(form.get("metadata"))) as Record<string, string>,
			});
			await afterInsert();
			return json(200, { result: { id, key: file.name } });
		}
		if (method === "GET" && target.pathname.endsWith("/items")) {
			const lookup = target.searchParams.get("key");
			const result = lookup ? items.filter((item) => item.key === lookup) : items;
			return json(200, { result, result_info: { count: result.length, total_count: result.length } });
		}
		if (method === "DELETE" && target.pathname.includes("/items/")) {
			const id = decodeURIComponent(target.pathname.slice(target.pathname.lastIndexOf("/") + 1));
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
			return json(200, { success: true });
		}
		return json(500, { errors: [{ message: `unexpected ${method} ${target}` }] });
	});
}

function pageKeys(items: Stored[]): string[] {
	return items.filter((item) => item.metadata.source_url === CANONICAL).map((item) => item.key);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("an admitted page has one live claim", () => {
	it("keeps one catalog item when two drains admit one page", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: SLASH, kind: "seed" },
				{ systemId: "backpack", url: QUERY, kind: "seed" },
			],
			"2026-01-01T00:00:00.000Z",
		);
		expect(
			await pageQueue.complete(
				await stampClaim(db, "backpack", SLASH, "2026-01-02T00:00:00.000Z"),
				{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
				PRIOR,
			),
		).toBe(true);
		await pageQueue.enqueueUpsert([{ systemId: "backpack", url: SLASH, kind: "seed" }], NOW);
		const items: Stored[] = [
			{
				id: "prior-id",
				key: PRIOR,
				body: "# old",
				metadata: { system: "backpack", source: "Backpack", source_url: CANONICAL },
			},
		];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stored!: () => void;
		const firstStored = new Promise<void>((resolve) => {
			stored = resolve;
		});
		let uploads = 0;
		vi.stubGlobal(
			"fetch",
			catalog(items, async () => {
				uploads += 1;
				if (uploads === 1) {
					stored();
					await gate;
				}
			}),
		);

		const first = drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: NOW,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		await firstStored;
		const second = await drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: LATER,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		release();
		const firstCounts = await first;
		expect({ first: firstCounts, second, page: pageKeys(items).length }).toEqual({
			first: { claimed: 1, indexed: 1, failed: 0 },
			second: { claimed: 0, indexed: 0, failed: 0 },
			page: 1,
		});

		const third = await drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: LATEST,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		expect(third).toEqual({ claimed: 1, indexed: 1, failed: 0 });
		expect(pageKeys(items)).toHaveLength(1);
		const rows = await db
			.prepare("SELECT url, status, item_key FROM page_work WHERE system_id = ? ORDER BY url")
			.bind("backpack")
			.all<{ url: string; status: string; item_key: string | null }>();
		expect(rows.results?.map((row) => row.status)).toEqual(["done", "done"]);
		expect(rows.results?.map((row) => row.item_key)).toContain(pageKeys(items)[0]);
		expect(pageKeys(items)[0]).not.toBe(PRIOR);
	});

	it("returns the second spelling to pending while the first claim is live", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: SLASH, kind: "seed" },
				{ systemId: "backpack", url: QUERY, kind: "seed" },
			],
			NOW,
		);
		const held = await pageQueue.claim(1, NOW);
		expect(held).toHaveLength(1);
		expect(await pageQueue.claim(1, LATER)).toEqual([]);
		const other = held[0]?.url === SLASH ? QUERY : SLASH;
		const row = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(other)
			.first<{ status: string; attempts: number }>();
		expect(row).toEqual({ status: "pending", attempts: 0 });
		expect(await pageQueue.complete(held[0]!, { lastCrawled: NOW, lastIndexed: NOW }, "backpack/page/k.md")).toBe(
			true,
		);
		expect((await pageQueue.claim(1, LATEST)).map((item) => item.url)).toEqual([other]);
	});

	it("keeps one catalog item when a repeated-slash row admits the same page", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		const repeated = `${CANONICAL}${"/".repeat(16)}`;
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: CANONICAL, kind: "seed" },
				{ systemId: "backpack", url: repeated, kind: "seed" },
			],
			NOW,
		);
		const items: Stored[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stored!: () => void;
		const firstStored = new Promise<void>((resolve) => {
			stored = resolve;
		});
		let uploads = 0;
		vi.stubGlobal(
			"fetch",
			catalog(items, async () => {
				uploads += 1;
				if (uploads === 1) {
					stored();
					await gate;
				}
			}),
		);
		const first = drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: NOW,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		await firstStored;
		const second = await drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: LATER,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		const repeatedRow = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(repeated)
			.first<{ status: string; attempts: number }>();
		expect(repeatedRow).toEqual({ status: "pending", attempts: 0 });
		expect(second).toEqual({ claimed: 0, indexed: 0, failed: 0 });
		expect(pageKeys(items)).toHaveLength(1);
		release();
		expect(await first).toEqual({ claimed: 1, indexed: 1, failed: 0 });
		expect(pageKeys(items)).toHaveLength(1);
	});

	it("returns the canonical row to pending while a multi-slash row is claimed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		const multi = `${CANONICAL}//`;
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: multi, kind: "seed" },
				{ systemId: "backpack", url: CANONICAL, kind: "seed" },
			],
			NOW,
		);
		const held = await pageQueue.claim(1, NOW);
		expect(held.map((item) => item.url)).toEqual([CANONICAL]);
		expect(await pageQueue.claim(1, LATER)).toEqual([]);
		const row = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(multi)
			.first<{ status: string; attempts: number }>();
		expect(row).toEqual({ status: "pending", attempts: 0 });
	});

	it("keeps the later drain's item when the first claim has expired", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: SLASH, kind: "seed" },
				{ systemId: "backpack", url: QUERY, kind: "seed" },
			],
			NOW,
		);
		const items: Stored[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stored!: () => void;
		const firstStored = new Promise<void>((resolve) => {
			stored = resolve;
		});
		let uploads = 0;
		vi.stubGlobal(
			"fetch",
			catalog(items, async () => {
				uploads += 1;
				if (uploads === 1) {
					stored();
					await gate;
				}
			}),
		);
		const first = drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: NOW,
			limit: 1,
			fetchMarkdown: async () => "# real",
		});
		await firstStored;
		const heldKey = pageKeys(items)[0];
		const second = await drainTick({
			queue: pageQueue,
			auth: AUTH,
			now: EXPIRED,
			limit: 2,
			fetchMarkdown: async () => "# real",
		});
		const survivor = pageKeys(items)[0];
		release();
		const firstCounts = await first;
		expect(firstCounts).toEqual({ claimed: 1, indexed: 0, failed: 0 });
		expect(second.indexed).toBeGreaterThan(0);
		expect(pageKeys(items)).toEqual([survivor]);
		expect(survivor).not.toBe(heldKey);
		expect(items.some((item) => item.key === survivor)).toBe(true);
	});
});
