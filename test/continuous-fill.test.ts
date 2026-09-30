import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { seedById } from "../src/config/seed.ts";
import worker from "../src/worker.ts";
import { discoverTick, commitDiscoveredUrls, deleteOrphanDocs, pickDiscoverSystem } from "../src/index/discover.ts";
import * as itemsRest from "../src/index/items-rest.ts";
import { drainTick } from "../src/index/drain.ts";
import { fillTick } from "../src/index/fill.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { D1PageQueue, FRESHNESS_MS } from "../src/index/page-queue.ts";
import { systemSeedHash } from "../src/index/seed-hash.ts";
import { readStatus } from "../src/index/status.ts";
import { DRIFT_CRON } from "../src/index/trigger.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-09-30T00:00:00.000Z";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function queue(): Promise<D1PageQueue> {
	const pageQueue = new D1PageQueue(memoryD1());
	await pageQueue.ensure();
	return pageQueue;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PageQueue claim order", () => {
	it("claims seed before reindex, then oldest lastIndexed, then enqueuedAt", async () => {
		const pageQueue = await queue();
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "govuk", url: "https://design-system.service.gov.uk/reindex-old", kind: "reindex" },
				{ systemId: "primer", url: "https://primer.style/seed-fresh", kind: "seed" },
				{ systemId: "primer", url: "https://primer.style/seed-new", kind: "seed" },
				{ systemId: "paste", url: "https://paste-dsys.com/reindex-missing", kind: "reindex" },
				{ systemId: "primer", url: "https://primer.style/seed-missing", kind: "seed" },
			],
			"2026-01-01T00:00:00.000Z",
		);
		await pageQueue.complete(
			{ systemId: "govuk", url: "https://design-system.service.gov.uk/reindex-old" },
			{ lastCrawled: "2020-01-01T00:00:00.000Z", lastIndexed: "2020-01-01T00:00:00.000Z" },
			null,
		);
		await pageQueue.complete(
			{ systemId: "primer", url: "https://primer.style/seed-fresh" },
			{ lastCrawled: "2024-06-01T00:00:00.000Z", lastIndexed: "2024-06-01T00:00:00.000Z" },
			null,
		);
		await pageQueue.complete(
			{ systemId: "primer", url: "https://primer.style/seed-new" },
			{ lastCrawled: "2024-06-01T00:00:00.000Z", lastIndexed: "2024-06-01T00:00:00.000Z" },
			null,
		);
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "govuk", url: "https://design-system.service.gov.uk/reindex-old", kind: "reindex" },
				{ systemId: "primer", url: "https://primer.style/seed-fresh", kind: "reindex" },
				{ systemId: "primer", url: "https://primer.style/seed-new", kind: "seed" },
			],
			"2026-02-01T00:00:00.000Z",
		);
		const db = pageQueueDb(pageQueue);
		await db
			.prepare("UPDATE page_work SET enqueued_at = ? WHERE url = ?")
			.bind("2026-03-01T00:00:00.000Z", "https://primer.style/seed-fresh")
			.run();
		await db
			.prepare("UPDATE page_work SET enqueued_at = ? WHERE url = ?")
			.bind("2026-04-01T00:00:00.000Z", "https://primer.style/seed-new")
			.run();

		const claimed = await pageQueue.claim(3, NOW);
		expect(claimed.map((item) => item.url)).toEqual([
			"https://primer.style/seed-missing",
			"https://primer.style/seed-fresh",
			"https://primer.style/seed-new",
		]);
		expect(claimed.every((item) => item.kind === "seed")).toBe(true);
		expect(claimed[1]?.lastIndexed).toBe("2024-06-01T00:00:00.000Z");
	});

	it("keeps enqueuedAt and lastIndexed when a url is rediscovered", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "reindex" }], "2026-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
			"primer/page/old.md",
		);
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2026-09-01T00:00:00.000Z");
		const row = await pageQueueDb(pageQueue)
			.prepare("SELECT kind, status, enqueued_at, last_indexed, last_crawled, item_key FROM page_work WHERE url = ?")
			.bind(url)
			.first<{
				kind: string;
				status: string;
				enqueued_at: string;
				last_indexed: string;
				last_crawled: string;
				item_key: string;
			}>();
		expect(row).toEqual({
			kind: "seed",
			status: "pending",
			enqueued_at: "2026-01-01T00:00:00.000Z",
			last_indexed: "2026-01-02T00:00:00.000Z",
			last_crawled: "2026-01-02T00:00:00.000Z",
			item_key: "primer/page/old.md",
		});
	});
});

describe("orphan prune", () => {
	it("drops queue rows and docs only after a successful discover", async () => {
		const pageQueue = await queue();
		const keep = "https://primer.style/keep";
		const orphan = "https://primer.style/gone";
		const failed = "https://primer.style/retry";
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "primer", url: keep, kind: "reindex" },
				{ systemId: "primer", url: orphan, kind: "reindex" },
				{ systemId: "primer", url: failed, kind: "reindex" },
			],
			NOW,
		);
		await pageQueue.complete(
			{ systemId: "primer", url: keep },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"primer/page/keep.md",
		);
		await pageQueue.fail({ systemId: "primer", url: failed }, "boom");
		const deleted: string[] = [];
		const blocked = await commitDiscoveredUrls({
			queue: pageQueue,
			systemId: "primer",
			kind: "seed",
			urls: [keep, failed, "https://primer.style/new"],
			ok: false,
			now: NOW,
			deleteDocs: async (dropped) => {
				deleted.push(...dropped.map((row) => row.url));
			},
		});
		expect(blocked.pruned).toEqual([]);
		expect(deleted).toEqual([]);
		expect(await urls(pageQueue)).toEqual([orphan, keep, failed]);

		const pruned = await commitDiscoveredUrls({
			queue: pageQueue,
			systemId: "primer",
			kind: "seed",
			urls: [keep, failed, "https://primer.style/new"],
			ok: true,
			now: NOW,
			deleteDocs: async (dropped) => {
				deleted.push(...dropped.map((row) => row.url));
			},
		});
		expect(pruned.pruned.map((row) => row.url)).toEqual([orphan]);
		expect(deleted).toEqual([orphan]);
		expect(await urls(pageQueue)).toEqual(["https://primer.style/keep", "https://primer.style/new", failed]);
		const failedRow = await pageQueueDb(pageQueue)
			.prepare("SELECT status FROM page_work WHERE url = ?")
			.bind(failed)
			.first<{ status: string }>();
		expect(failedRow?.status).toBe("pending");
	});

	it("does not prune when a running discover fails before the crawl completes", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const orphan = "https://primer.style/still-there";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url: orphan, kind: "reindex" }], NOW);
		await pageQueue.insertRun({
			systemId: "primer",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-1",
			startUrl: "https://primer.style/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const deleted: string[] = [];
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "errored", finished: 1 }),
			deleteDocs: async (_auth, _system, dropped) => {
				deleted.push(...dropped.map((row) => row.url));
			},
			cancel: async () => undefined,
		});
		expect(result.action).toBe("failed");
		expect(deleted).toEqual([]);
		expect(await urls(pageQueue)).toEqual([orphan]);
		expect(await pageQueue.running()).toBeNull();
	});
});

describe("drain wipe bar", () => {
	it("leaves the previous page in place when indexing throws", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const url = "https://primer.style/components/select";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2026-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
			"primer/page/previous.md",
		);
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push(method);
				if (method === "GET") {
					return json(200, { result: { id: "design-guide" } });
				}
				return json(500, { errors: [{ code: 1, message: "oom" }] });
			}),
		);
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select guidance",
		});
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 1 });
		expect(calls).not.toContain("DELETE");
		const row = await db
			.prepare("SELECT status, last_indexed, item_key, error FROM page_work WHERE url = ?")
			.bind(url)
			.first<{ status: string; last_indexed: string; item_key: string; error: string }>();
		expect(row?.status).toBe("failed");
		expect(row?.last_indexed).toBe("2026-01-02T00:00:00.000Z");
		expect(row?.item_key).toBe("primer/page/previous.md");
		expect(row?.error).toContain("oom");
	});
});

describe("continuous fill", () => {
	it("prefers a drifted live system over a parked seed and a due recheck", () => {
		expect(
			pickDiscoverSystem({
				cron: DRIFT_CRON,
				drifted: ["paste", "primer"],
				due: ["govuk"],
				parked: ["paste"],
				parks: { paste: { reason: "stub", usable: 1, at: NOW } },
			}),
		).toEqual({ systemId: "primer", kind: "seed", trigger: "deploy-drift" });
	});

	it("indexes a batch while older pages stay queued and does not send fail mail", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kv = memoryKV();
		const sent: Array<{ subject?: string }> = [];
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
			EMAIL: {
				send: async (message) => {
					sent.push(message as { subject?: string });
					return { messageId: "m" };
				},
			},
		});
		for (const id of SYSTEM_IDS) {
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
			await pageQueue.markDiscovered(id, NOW);
		}
		const urls = Array.from({ length: 120 }, (_value, index) => `https://primer.style/page-${index}`);
		await pageQueue.enqueueUpsert(
			urls.map((url) => ({ systemId: "primer" as const, url, kind: "reindex" as const })),
			"2020-01-01T00:00:00.000Z",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (method === "GET" && url.includes("/ai-search/instances/")) {
					return json(200, { result: { id: "design-guide" } });
				}
				if (url.endsWith("/markdown")) {
					return json(200, { result: "# accessible combobox guidance" });
				}
				if (method === "POST" && url.includes("/items")) {
					return json(200, { result: { id: "item", key: "primer/page/new.md" } });
				}
				return json(500, { errors: [{ code: 1, message: `unexpected ${method} ${url}` }] });
			}),
		);
		await fillTick(env, DRIFT_CRON, new Date(NOW));
		const status = await readStatus(env);
		expect(status.queue.done).toBe(100);
		expect(status.queue.pending).toBe(20);
		expect(status.state).toBe("running");
		expect(status.runError).toBeUndefined();
		const primer = status.freshness.find((row) => row.system === "primer");
		expect(primer?.lastIndexed).toBe(NOW);
		expect(primer?.lastCrawled).toBe(NOW);
		expect(primer?.pending).toBe(20);
		expect(sent.map((message) => message.subject ?? "")).not.toEqual(
			expect.arrayContaining([expect.stringContaining("fail")]),
		);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "accessible combobox or listbox keyboard and focus guidance" }),
			}),
			env,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { results: Array<{ system: string }> };
		expect(body.results.length).toBeGreaterThan(0);
		expect(Date.parse(NOW) - Date.parse("2020-01-01T00:00:00.000Z")).toBeGreaterThan(FRESHNESS_MS);
	});
});

describe("deleteOrphanDocs", () => {
	it("deletes system docs whose url is outside the live set and keeps urls still on the map", async () => {
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "old-gen",
				key: "primer/20260101/abc.md",
				metadata: { system: "primer", source_url: "https://primer.style/retired" },
			},
			{
				id: "kept",
				key: "primer/page/keep.md",
				metadata: { system: "primer", source_url: "https://primer.style/keep" },
			},
			{
				id: "other",
				key: "paste/page/other.md",
				metadata: { system: "paste", source_url: "https://paste-dsys.com/gone" },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		await deleteOrphanDocs(
			{ accountId: "acct", apiToken: "token", instanceId: "design-guide" },
			"primer",
			[],
			new Set(["https://primer.style/keep"]),
		);
		expect(deleted).toEqual(["old-gen"]);
	});
});

describe("recovery cron", () => {
	it("treats Cloudflare's Sunday forms as the parked-seed slot", () => {
		const parked = ["vanilla"] as const;
		for (const cron of ["0 6 * * SUN", "0 6 * * 1", "0 6 * * 0"]) {
			expect(
				pickDiscoverSystem({
					cron,
					drifted: [],
					due: ["primer"],
					parked: [...parked],
					parks: { vanilla: { reason: "stub", usable: 0, at: NOW } },
				})?.systemId,
			).toBe("vanilla");
		}
	});
});

function pageQueueDb(pageQueue: D1PageQueue): D1Database {
	return (pageQueue as unknown as { db: D1Database }).db;
}

async function urls(pageQueue: D1PageQueue): Promise<string[]> {
	const rows = await pageQueueDb(pageQueue)
		.prepare("SELECT url FROM page_work ORDER BY url ASC")
		.all<{ url: string }>();
	return rows.results.map((row) => row.url);
}
