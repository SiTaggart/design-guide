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
	it("stores one page for a slash spelling and a query spelling", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "backpack", url: SLASH, kind: "seed" },
				{ systemId: "backpack", url: QUERY, kind: "seed" },
			],
			"2026-01-01T00:00:00.000Z",
		);
		const rows = await db.prepare("SELECT url, status FROM page_work ORDER BY url").all<{ url: string; status: string }>();
		expect(rows.results).toEqual([{ url: CANONICAL, status: "pending" }]);
		const held = await pageQueue.claim(1, NOW);
		expect(held.map((item) => item.url)).toEqual([CANONICAL]);
		expect(await pageQueue.claim(1, LATER)).toEqual([]);
		expect(
			await pageQueue.complete(held[0]!, { lastCrawled: NOW, lastIndexed: NOW }, "backpack/page/k.md"),
		).toBe(true);
		expect((await pageQueue.claim(1, LATEST)).map((item) => item.url)).toEqual([]);
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
