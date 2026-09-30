import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { seedById } from "../src/config/seed.ts";
import worker from "../src/worker.ts";
import {
	CAP_RETRY_MS,
	discoverTick,
	commitDiscoveredUrls,
	deleteOrphanDocs,
	pickDiscoverSystem,
} from "../src/index/discover.ts";
import * as itemsRest from "../src/index/items-rest.ts";
import { drainTick, indexQueuedPage, pageItemKey } from "../src/index/drain.ts";
import { fillTick, noteIndexedSeeds } from "../src/index/fill.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { D1PageQueue, FRESHNESS_MS, MAX_ATTEMPTS } from "../src/index/page-queue.ts";
import { readParks } from "../src/index/parks.ts";
import { holdRetrieval, readRetrievalHold } from "../src/index/retrieval-hold.ts";
import { seedHashKey, systemSeedHash } from "../src/index/seed-hash.ts";
import { emptyStatus, readStatus, writeStatus } from "../src/index/status.ts";
import { DRIFT_CRON, RECOVERY_CRON } from "../src/index/trigger.ts";
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
	vi.restoreAllMocks();
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
		expect(await pageQueue.seedRefreshes()).toEqual({});
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
				if (method === "GET" && url.includes("/items")) {
					return json(200, { result: [], result_info: { total_count: 0 } });
				}
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

describe("drain claim ownership", () => {
	it("does not upload or delete when the claim is lost before the replacement", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		const upload = vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "newer",
				key: "primer/page/newer.md",
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(async (_auth, key) => {
			deleted.push(key);
		});
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => {
				await stealClaim(pageQueue, url, "2026-09-30T00:20:00.000Z");
				return "# select";
			},
		});
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 0 });
		expect(upload).not.toHaveBeenCalled();
		expect(deleted).toEqual([]);
		const row = await workRow(pageQueue, url);
		expect(row?.status).toBe("claimed");
		expect(row?.claimed_at).toBe("2026-09-30T00:20:00.000Z");
		expect(row?.item_key).toBeNull();
	});

	it("drops the untracked upload when the claim is lost after upload and keeps the live page", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		const liveKey = "primer/page/previous.md";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2026-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
			liveKey,
		);
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockImplementation(async () => {
			await stealClaim(pageQueue, url, "2026-09-30T00:20:00.000Z");
			return { id: "stale", key: "primer/page/stale.md" };
		});
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "live",
				key: liveKey,
				metadata: { system: "primer", source_url: url },
			},
			{
				id: "newer",
				key: "primer/page/newer.md",
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(async (_auth, key) => {
			deleted.push(key);
		});
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 0 });
		expect(deleted).toEqual([pageItemKey("primer", url, 1, NOW)]);
		const row = await workRow(pageQueue, url);
		expect(row?.status).toBe("claimed");
		expect(row?.claimed_at).toBe("2026-09-30T00:20:00.000Z");
		expect(row?.item_key).toBe(liveKey);
	});

	it("keeps the replacement and does not clear a later failure when the claim is lost after the older item is deleted", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		const liveKey = "primer/page/previous.md";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2026-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
			liveKey,
		);
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "legacy",
				key: liveKey,
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
			await pageQueueDb(pageQueue)
				.prepare(
					"UPDATE page_work SET status = 'failed', attempts = ?, claimed_at = NULL, error = ?, item_key = ? WHERE url = ?",
				)
				.bind(MAX_ATTEMPTS, "gave up", liveKey, url)
				.run();
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(async (_auth, key) => {
			deleted.push(key);
		});
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 0 });
		expect(deleted).toEqual(["legacy"]);
		const row = await pageQueueDb(pageQueue)
			.prepare("SELECT status, attempts, item_key, error FROM page_work WHERE url = ?")
			.bind(url)
			.first<{ status: string; attempts: number; item_key: string; error: string | null }>();
		expect(row).toEqual({ status: "failed", attempts: MAX_ATTEMPTS, item_key: liveKey, error: "gave up" });
		expect(await pageQueue.claim(1, "2026-09-30T00:30:00.000Z")).toEqual([]);
	});

	it("records the replacement and stays retryable when the final claim expires after the older item is deleted", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		const liveKey = "primer/page/previous.md";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2026-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2026-01-02T00:00:00.000Z", lastIndexed: "2026-01-02T00:00:00.000Z" },
			liveKey,
		);
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET attempts = ? WHERE url = ?")
			.bind(MAX_ATTEMPTS - 1, url)
			.run();
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "legacy",
				key: liveKey,
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
			await pageQueueDb(pageQueue)
				.prepare(
					"UPDATE page_work SET status = 'failed', claimed_at = NULL, error = COALESCE(error, 'claim expired') WHERE url = ?",
				)
				.bind(url)
				.run();
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(async (_auth, key) => {
			deleted.push(key);
		});
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		const replacement = pageItemKey("primer", url, MAX_ATTEMPTS, NOW);
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 0 });
		expect(deleted).toEqual(["legacy"]);
		const row = await pageQueueDb(pageQueue)
			.prepare("SELECT status, attempts, item_key, error FROM page_work WHERE url = ?")
			.bind(url)
			.first<{ status: string; attempts: number; item_key: string; error: string | null }>();
		expect(row).toEqual({
			status: "pending",
			attempts: MAX_ATTEMPTS - 1,
			item_key: replacement,
			error: null,
		});
		expect((await pageQueue.claim(1, "2026-09-30T00:30:00.000Z")).map((item) => item.url)).toEqual([url]);
	});
});

describe("legacy cleanup retry", () => {
	it("leaves the page retryable when listing older items fails, then cleans up on a later tick", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		const list = vi.spyOn(itemsRest, "listItems").mockRejectedValue(new Error("list down"));
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		const first = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		expect(first).toEqual({ claimed: 1, indexed: 0, failed: 1 });
		expect(deleted).toEqual([]);
		expect(await workRow(pageQueue, url)).toMatchObject({ status: "failed", error: "legacy cleanup failed" });
		list.mockResolvedValue([
			{
				id: "legacy",
				key: "primer/20260101/abc.md",
				metadata: { system: "primer", source_url: url },
			},
		]);
		const second = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: "2026-09-30T00:05:00.000Z",
			fetchMarkdown: async () => "# select",
		});
		expect(second).toEqual({ claimed: 1, indexed: 1, failed: 0 });
		expect(deleted).toEqual(["legacy"]);
		expect((await workRow(pageQueue, url))?.status).toBe("done");
	});

	it("marks the page done when delete-by-id fails and delete-by-key removes the legacy item", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "legacy",
				key: "primer/20260101/abc.md",
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockRejectedValue(new Error("delete by id down"));
		const deletedKeys: string[] = [];
		vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(async (_auth, key) => {
			deletedKeys.push(key);
		});
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		expect(counts).toEqual({ claimed: 1, indexed: 1, failed: 0 });
		expect(deletedKeys).toEqual(["primer/20260101/abc.md"]);
		expect((await workRow(pageQueue, url))?.status).toBe("done");
	});

	it("does not mark the page done when deleting an older item fails", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/components/select";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "legacy",
				key: "primer/20260101/abc.md",
				metadata: { system: "primer", source_url: url },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockRejectedValue(new Error("delete down"));
		vi.spyOn(itemsRest, "deleteItemByKey").mockRejectedValue(new Error("delete down"));
		const counts = await drainTick({
			queue: pageQueue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# select",
		});
		expect(counts).toEqual({ claimed: 1, indexed: 0, failed: 1 });
		const row = await workRow(pageQueue, url);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe("legacy cleanup failed");
	});
});

describe("releaseForRetry", () => {
	it("releases only the claim it still owns and leaves a later exhausted failure in place", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/owned";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const [owned] = await pageQueue.claim(1, NOW);
		expect(await pageQueue.releaseForRetry(owned!, "primer/page/replacement.md")).toBe(true);
		expect(
			await pageQueueDb(pageQueue)
				.prepare("SELECT status, attempts, item_key, error, claimed_at FROM page_work WHERE url = ?")
				.bind(url)
				.first(),
		).toEqual({
			status: "pending",
			attempts: 1,
			item_key: "primer/page/replacement.md",
			error: null,
			claimed_at: null,
		});
		await pageQueueDb(pageQueue)
			.prepare(
				"UPDATE page_work SET status = 'failed', attempts = ?, item_key = ?, error = ?, claimed_at = NULL WHERE url = ?",
			)
			.bind(MAX_ATTEMPTS, "primer/page/later.md", "gave up", url)
			.run();
		expect(await pageQueue.releaseForRetry(owned!, "primer/page/stale.md")).toBe(false);
		expect(
			await pageQueueDb(pageQueue)
				.prepare("SELECT status, attempts, item_key, error, claimed_at FROM page_work WHERE url = ?")
				.bind(url)
				.first(),
		).toEqual({
			status: "failed",
			attempts: MAX_ATTEMPTS,
			item_key: "primer/page/later.md",
			error: "gave up",
			claimed_at: null,
		});
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET status = 'failed', attempts = ?, item_key = ?, error = 'claim expired', claimed_at = NULL WHERE url = ?")
			.bind(owned!.attempts, "primer/page/deleted.md", url)
			.run();
		expect(await pageQueue.releaseForRetry(owned!, "primer/page/kept.md")).toBe(true);
		expect(
			await pageQueueDb(pageQueue)
				.prepare("SELECT status, attempts, item_key, error, claimed_at FROM page_work WHERE url = ?")
				.bind(url)
				.first(),
		).toEqual({
			status: "pending",
			attempts: owned!.attempts,
			item_key: "primer/page/kept.md",
			error: null,
			claimed_at: null,
		});
	});
});

describe("claim ownership", () => {
	it("ignores a complete from a tick that no longer owns the claim", async () => {
		const pageQueue = await queue();
		const url = "https://primer.style/owned";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], NOW);
		const [owned] = await pageQueue.claim(1, NOW);
		expect(owned?.claimedAt).toBe(NOW);
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET attempts = attempts + 1, claimed_at = ? WHERE url = ?")
			.bind("2026-09-30T00:20:00.000Z", url)
			.run();
		const wrote = await pageQueue.complete(
			owned!,
			{ lastCrawled: NOW, lastIndexed: NOW },
			"primer/page/stale.md",
		);
		expect(wrote).toBe(false);
		const row = await pageQueueDb(pageQueue)
			.prepare("SELECT status, attempts, claimed_at, item_key FROM page_work WHERE url = ?")
			.bind(url)
			.first<{ status: string; attempts: number; claimed_at: string; item_key: string | null }>();
		expect(row).toEqual({
			status: "claimed",
			attempts: 2,
			claimed_at: "2026-09-30T00:20:00.000Z",
			item_key: null,
		});
		expect(await pageQueue.fail(owned!, "stale worker")).toBe(false);
		expect(
			(
				await pageQueueDb(pageQueue)
					.prepare("SELECT status, claimed_at FROM page_work WHERE url = ?")
					.bind(url)
					.first<{ status: string; claimed_at: string }>()
			)?.status,
		).toBe("claimed");
	});
});

describe("live map prune", () => {
	it("keeps a crawled url that was not usable and still prunes urls absent from the map", async () => {
		const pageQueue = await queue();
		const keep = "https://primer.style/keep";
		const blurry = "https://primer.style/blurry";
		const gone = "https://primer.style/gone";
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "primer", url: keep, kind: "reindex" },
				{ systemId: "primer", url: blurry, kind: "reindex" },
				{ systemId: "primer", url: gone, kind: "reindex" },
			],
			NOW,
		);
		await pageQueue.complete(
			{ systemId: "primer", url: blurry },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"primer/page/blurry.md",
		);
		const deleted: string[] = [];
		const pruned = await commitDiscoveredUrls({
			queue: pageQueue,
			systemId: "primer",
			kind: "seed",
			urls: [keep, "https://primer.style/new"],
			liveUrls: [keep, "https://primer.style/new", blurry],
			ok: true,
			now: NOW,
			deleteDocs: async (dropped) => {
				deleted.push(...dropped.map((row) => row.url));
			},
		});
		expect(pruned.pruned.map((row) => row.url)).toEqual([gone]);
		expect(deleted).toEqual([gone]);
		const blurryRow = await pageQueueDb(pageQueue)
			.prepare("SELECT status, item_key FROM page_work WHERE url = ?")
			.bind(blurry)
			.first<{ status: string; item_key: string }>();
		expect(blurryRow).toEqual({ status: "done", item_key: "primer/page/blurry.md" });
	});

	it("does not delete a still-live doc when this crawl could not replace it", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const blurry = "https://primer.style/blurry";
		const gone = "https://primer.style/gone";
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "primer", url: blurry, kind: "reindex" },
				{ systemId: "primer", url: gone, kind: "reindex" },
			],
			NOW,
		);
		await pageQueue.insertRun({
			systemId: "primer",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-live",
			startUrl: "https://primer.style/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "blurry-doc",
				key: "primer/old/blurry.md",
				metadata: { system: "primer", source_url: blurry },
			},
			{
				id: "gone-doc",
				key: "primer/old/gone.md",
				metadata: { system: "primer", source_url: gone },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 3 }),
			page: async () => ({
				records: [
					{ url: "https://primer.style/keep", status: "completed", markdown: "# keep" },
					{ url: "https://primer.style/also", status: "completed", markdown: "# also" },
					{ url: blurry, status: "completed", markdown: "   " },
				],
				cursor: null,
			}),
			cancel: async () => undefined,
		});
		expect(result.action).toBe("enqueued");
		expect(deleted).toEqual(["gone-doc"]);
		expect((await pageQueue.seedRefreshes()).primer?.seedHash).toBe(systemSeedHash(seedById("primer")));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		const urlsLeft = await urls(pageQueue);
		expect(urlsLeft).toContain(blurry);
		expect(urlsLeft).not.toContain(gone);
		expect(urlsLeft).toContain("https://primer.style/keep");
	});
});

describe("legacy page copies", () => {
	it("deletes older items for the same url after the new upload succeeds", async () => {
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({
			id: "fresh",
			key: "primer/page/fresh.md",
		});
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{
				id: "legacy",
				key: "primer/20260101/abc.md",
				metadata: { system: "primer", source_url: "https://primer.style/select" },
			},
			{
				id: "other-system",
				key: "paste/page/abc.md",
				metadata: { system: "paste", source_url: "https://primer.style/select" },
			},
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		const key = await indexQueuedPage(
			{ accountId: "acct", apiToken: "token", instanceId: "design-guide" },
			seedById("primer"),
			{
				systemId: "primer",
				url: "https://primer.style/select",
				kind: "seed",
				enqueuedAt: NOW,
				attempts: 1,
				status: "claimed",
				itemKey: null,
			},
			"# select",
			{ lastCrawled: NOW, lastIndexed: NOW },
		);
		expect(key.startsWith("primer/page/")).toBe(true);
		expect(deleted).toEqual(["legacy"]);
	});
});

describe("park stickiness", () => {
	it("does not unpark a stub because older done rows are still in the queue", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await pageQueue.insertRun({
			systemId: "vanilla",
			kind: "reindex",
			trigger: "recovery",
			jobId: "job-stub",
			startUrl: "https://vanillaframework.io/docs/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.enqueueUpsert(
			[
				{ systemId: "vanilla", url: "https://vanillaframework.io/docs/a", kind: "reindex" },
				{ systemId: "vanilla", url: "https://vanillaframework.io/docs/b", kind: "reindex" },
			],
			NOW,
		);
		await pageQueue.complete(
			{ systemId: "vanilla", url: "https://vanillaframework.io/docs/a" },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"vanilla/page/a.md",
		);
		await pageQueue.complete(
			{ systemId: "vanilla", url: "https://vanillaframework.io/docs/b" },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"vanilla/page/b.md",
		);
		await holdRetrieval(env, "vanilla");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = String(input);
				if (url.includes("status=completed")) {
					return json(200, {
						result: {
							records: [
								{
									url: "https://vanillaframework.io/docs/",
									status: "completed",
									markdown: "# one",
								},
							],
							cursor: null,
						},
					});
				}
				return json(200, { result: { status: "completed", finished: 1 } });
			}),
		);
		await fillTick(env, DRIFT_CRON, new Date(NOW));
		const parks = await readParks(env);
		expect(parks.kind).toBe("ok");
		if (parks.kind === "ok") {
			expect(parks.parks.vanilla?.reason).toBe("stub");
		}
		const hold = await readRetrievalHold(env);
		expect(hold.kind).toBe("ok");
		if (hold.kind === "ok") {
			expect(hold.systems.has("vanilla")).toBe(true);
		}
		expect(await urls(pageQueue)).toEqual([]);
	});
});

describe("indexed seed hash", () => {
	it("writes the seed hash only after the current refresh is fully indexed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
		});
		const hash = systemSeedHash(seedById("primer"));
		const url = "https://primer.style/components";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], "2020-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2020-01-02T00:00:00.000Z", lastIndexed: "2020-01-02T00:00:00.000Z" },
			"primer/page/components.md",
		);
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		await pageQueue.recordSeedRefresh("primer", "previous-seed", "2020-01-01T00:00:00.000Z");
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		await pageQueue.recordSeedRefresh("primer", hash, NOW);
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		await pageQueue.insertRun({
			systemId: "primer",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-open",
			startUrl: "https://primer.style/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET last_indexed = ?, last_crawled = ? WHERE url = ?")
			.bind(NOW, NOW, url)
			.run();
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		await pageQueue.clearRun("primer");
		await pageQueue.enqueueUpsert([{ systemId: "primer", url: "https://primer.style/missing", kind: "seed" }], NOW);
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET status = 'failed', attempts = ? WHERE url = ?")
			.bind(MAX_ATTEMPTS, "https://primer.style/missing")
			.run();
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		await pageQueueDb(pageQueue).prepare("DELETE FROM page_work WHERE status = 'failed'").run();
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await kv.get(seedHashKey("primer"))).toBe(hash);
	});

	it("leaves the hash stale when discover for the new seed fails", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const url = "https://primer.style/components";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "reindex" }], "2020-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: "2020-01-02T00:00:00.000Z", lastIndexed: "2020-01-02T00:00:00.000Z" },
			"primer/page/components.md",
		);
		await pageQueue.insertRun({
			systemId: "primer",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-failed-seed",
			startUrl: "https://primer.style/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "errored", finished: 1 }),
			deleteDocs: async () => {
				throw new Error("failed discover must not prune");
			},
			cancel: async () => undefined,
		});
		expect(result.action).toBe("failed");
		await noteIndexedSeeds(env, pageQueue, new Date(NOW));
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		expect(await urls(pageQueue)).toEqual([url]);
	});
});

describe("exhausted failures", () => {
	it("marks status failed when every remaining page has exhausted retries", async () => {
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
		await pageQueue.enqueueUpsert(
			[{ systemId: "primer", url: "https://primer.style/stuck", kind: "reindex" }],
			NOW,
		);
		await pageQueueDb(pageQueue)
			.prepare("UPDATE page_work SET status = 'failed', attempts = ?, error = ? WHERE url = ?")
			.bind(MAX_ATTEMPTS, "gave up", "https://primer.style/stuck")
			.run();
		await fillTick(env, DRIFT_CRON, new Date(NOW));
		const status = await readStatus(env);
		expect(status.state).toBe("fail");
		expect(status.runError).toBe("queue stuck");
		expect(status.queue.failed).toBe(1);
		expect(sent.map((message) => message.subject ?? "")).toEqual(
			expect.arrayContaining([expect.stringContaining("fail")]),
		);
	});
});

describe("recovery cron", () => {
	it("rotates to the parked system that has waited longest", () => {
		expect(
			pickDiscoverSystem({
				cron: RECOVERY_CRON,
				drifted: [],
				due: ["primer"],
				parked: ["vanilla", "garden"],
				parks: {
					vanilla: { reason: "stub", usable: 1, at: NOW },
					garden: { reason: "stub", usable: 1, at: NOW },
				},
				recoveryAttempts: { vanilla: "2026-09-28T00:00:00.000Z" },
			})?.systemId,
		).toBe("garden");
	});

	it("does not rediscover a drifted system that still has queued pages", () => {
		expect(
			pickDiscoverSystem({
				cron: DRIFT_CRON,
				drifted: ["primer", "paste"],
				due: [],
				parked: [],
				parks: {},
				busy: new Set(["primer"]),
			}),
		).toEqual({ systemId: "paste", kind: "seed", trigger: "deploy-drift" });
	});

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

describe("page cap recovery", () => {
	it("creates later queue tables when a multi-statement exec fails", async () => {
		const db = memoryD1();
		const exec = db.exec.bind(db);
		db.exec = (async (sql: string) => {
			if (sql.includes("\n")) {
				throw new Error("D1_EXEC_ERROR: incomplete input");
			}
			const parts = sql
				.split(";")
				.map((part) => part.trim())
				.filter(Boolean);
			if (parts.length > 1) {
				throw new Error("D1_EXEC_ERROR: multiple statements");
			}
			return exec(sql);
		}) as D1Database["exec"];
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await expect(pageQueue.capDefers()).resolves.toEqual({});
		await expect(pageQueue.seedRefreshes()).resolves.toEqual({});
		await expect(pageQueue.recoveryAttempts()).resolves.toEqual({});
	});

	it("enqueues pages from a capped crawl and does not prune the previous url", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const previous = "https://paste-dsys.com/old";
		await pageQueue.enqueueUpsert([{ systemId: "paste", url: previous, kind: "reindex" }], "2020-01-01T00:00:00.000Z");
		await pageQueue.complete(
			{ systemId: "paste", url: previous },
			{ lastCrawled: "2020-01-02T00:00:00.000Z", lastIndexed: "2020-01-02T00:00:00.000Z" },
			"paste/page/old.md",
		);
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-cap",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "cancelled_due_to_limits", finished: 533, total: 533 }),
			page: async () => ({
				records: [
					{ url: "https://paste-dsys.com/a", status: "completed", markdown: "# a" },
					{ url: "https://paste-dsys.com/b", status: "completed", markdown: "# b" },
				],
				cursor: null,
			}),
			deleteDocs: async () => {
				throw new Error("page cap must not prune");
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({ action: "enqueued", systemId: "paste", urls: 2, pruned: [] });
		expect(await pageQueue.running()).toBeNull();
		expect(await urls(pageQueue)).toEqual([
			"https://paste-dsys.com/a",
			"https://paste-dsys.com/b",
			previous,
		]);
		const parks = await readParks(env);
		expect(parks.kind).toBe("ok");
		if (parks.kind === "ok") {
			expect(parks.parks.paste).toBeUndefined();
		}
		expect((await pageQueue.seedRefreshes()).paste?.seedHash).toBe(systemSeedHash(seedById("paste")));
	});

	it("defers a capped seed with no usable pages so the next tick discovers another drifted seed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-empty-cap",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const started: string[] = [];
		const capped = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "cancelled_due_to_limits", finished: 533, total: 533 }),
			page: async () => ({ records: [{ url: "https://paste-dsys.com/", status: "completed", markdown: "   " }], cursor: null }),
			cancel: async () => undefined,
		});
		expect(capped).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			urls: 0,
			pruned: [],
		});
		expect(await pageQueue.running()).toBeNull();
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
		const parks = await readParks(env);
		expect(parks.kind).toBe("ok");
		if (parks.kind === "ok") {
			expect(parks.parks.paste).toBeUndefined();
		}
		const next = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			start: async (_auth, seed) => {
				started.push(seed.id);
				return { startUrl: seed.startUrl, jobId: `job-${seed.id}` };
			},
			cancel: async () => undefined,
		});
		expect(started).toEqual(["primer"]);
		expect(next).toMatchObject({ action: "started", systemId: "primer", trigger: "deploy-drift" });
	});

	it("pages a capped crawl to the end in one tick and discovers the next drifted seed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-cap-pages",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const cursors: Array<string | number | undefined> = [];
		let calls = 0;
		const cancelled: string[] = [];
		const capped = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "errored", finished: 533, total: 533 }),
			page: async (_auth, _job, _status, cursor) => {
				calls += 1;
				cursors.push(cursor);
				if (calls === 1) {
					return {
						records: [{ url: "https://paste-dsys.com/a", status: "completed", markdown: "# a" }],
						cursor: "2",
					};
				}
				return {
					records: [{ url: "https://paste-dsys.com/b", status: "completed", markdown: "# b" }],
					cursor: null,
				};
			},
			cancel: async (_auth, jobId) => {
				cancelled.push(jobId);
			},
			deleteDocs: async () => {
				throw new Error("page cap must not prune");
			},
		});
		expect(capped).toMatchObject({ action: "enqueued", systemId: "paste", urls: 2, pruned: [] });
		expect(calls).toBe(2);
		expect(cursors).toEqual([undefined, "2"]);
		expect(cancelled).toEqual([]);
		expect(await pageQueue.running()).toBeNull();
		const started: string[] = [];
		const next = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			start: async (_auth, seed) => {
				started.push(seed.id);
				return { startUrl: seed.startUrl, jobId: `job-${seed.id}` };
			},
		});
		expect(started).toEqual(["primer"]);
		expect(next).toMatchObject({ action: "started", systemId: "primer" });
		expect((await urls(pageQueue)).filter((url) => url.includes("paste-dsys.com"))).toEqual([
			"https://paste-dsys.com/a",
			"https://paste-dsys.com/b",
		]);
	});

	it("skips a fresh page-cap deferral and retries that seed once the hour has passed", () => {
		const deferred = { paste: NOW };
		expect(
			pickDiscoverSystem({
				cron: DRIFT_CRON,
				drifted: ["paste", "primer"],
				due: ["uswds"],
				parked: [],
				parks: {},
				deferred,
				now: Date.parse(NOW),
			}),
		).toEqual({ systemId: "primer", kind: "seed", trigger: "deploy-drift" });
		expect(
			pickDiscoverSystem({
				cron: DRIFT_CRON,
				drifted: ["paste"],
				due: ["paste"],
				parked: [],
				parks: {},
				deferred,
				now: Date.parse(NOW),
			}),
		).toBeNull();
		expect(
			pickDiscoverSystem({
				cron: DRIFT_CRON,
				drifted: ["paste"],
				due: ["paste"],
				parked: [],
				parks: {},
				deferred,
				now: Date.parse(NOW) + CAP_RETRY_MS,
			}),
		).toEqual({ systemId: "paste", kind: "seed", trigger: "deploy-drift" });
	});

	it("clears a page-limit fail by queueing capped pages and discovering the next seed", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await writeStatus(env, {
			...emptyStatus(false),
			state: "fail",
			trigger: "deploy-drift",
			runError: "crawl hit the 500 page limit",
			workflowId: "discover-deploy-drift-paste",
			systems: [
				{
					system: "paste",
					startUrl: "https://paste-dsys.com/",
					crawl: { total: 533, finished: 533, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: true,
					keptPrevious: true,
					usable: 0,
					error: "crawl hit the 500 page limit",
				},
			],
		});
		const started: string[] = [];
		const deps = {
			start: async (_auth: { accountId: string; apiToken: string }, seed: { id: string; startUrl: string }) => {
				started.push(seed.id);
				return { startUrl: seed.startUrl, jobId: `job-${seed.id}` };
			},
			poll: async () => ({ status: "cancelled_due_to_limits" as const, finished: 533, total: 533 }),
			page: async () => ({
				records: [
					{ url: "https://paste-dsys.com/a", status: "completed", markdown: "# accessible combobox" },
					{ url: "https://paste-dsys.com/b", status: "completed", markdown: "# focus guidance" },
				],
				cursor: null,
			}),
			deleteDocs: async () => {
				throw new Error("page cap must not prune");
			},
			cancel: async () => undefined,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (method === "GET" && url.includes("/items")) {
					return json(200, { result: [], result_info: { total_count: 0 } });
				}
				if (method === "GET" && url.includes("/ai-search/instances/")) {
					return json(200, { result: { id: "design-guide" } });
				}
				if (url.endsWith("/markdown")) {
					return json(200, { result: "# accessible combobox guidance" });
				}
				if (method === "POST" && url.includes("/items")) {
					return json(200, { result: { id: "item", key: "paste/page/new.md" } });
				}
				return json(500, { errors: [{ code: 1, message: `unexpected ${method} ${url}` }] });
			}),
		);
		await fillTick(env, DRIFT_CRON, new Date(NOW), deps);
		expect(started).toEqual(["paste"]);
		await fillTick(env, DRIFT_CRON, new Date("2026-09-30T00:05:00.000Z"), deps);
		const filled = await readStatus(env);
		expect(filled.runError).toBeUndefined();
		expect(filled.state).not.toBe("fail");
		expect(filled.queue.pending + filled.queue.done).toBeGreaterThan(0);
		expect(filled.systems.find((entry) => entry.system === "paste")?.error).toBeUndefined();
		await fillTick(env, DRIFT_CRON, new Date("2026-09-30T00:10:00.000Z"), deps);
		expect(started).toEqual(["paste", "primer"]);
		const moved = await readStatus(env);
		expect(moved.discover?.systemId).toBe("primer");
		expect(moved.state).toBe("running");
		expect(moved.runError).toBeUndefined();
	});
});

async function stealClaim(pageQueue: D1PageQueue, url: string, claimedAt: string): Promise<void> {
	await pageQueueDb(pageQueue)
		.prepare("UPDATE page_work SET attempts = attempts + 1, claimed_at = ? WHERE url = ?")
		.bind(claimedAt, url)
		.run();
}

async function workRow(
	pageQueue: D1PageQueue,
	url: string,
): Promise<{ status: string; claimed_at: string | null; item_key: string | null; error: string | null } | null> {
	return pageQueueDb(pageQueue)
		.prepare("SELECT status, claimed_at, item_key, error FROM page_work WHERE url = ?")
		.bind(url)
		.first<{ status: string; claimed_at: string | null; item_key: string | null; error: string | null }>();
}

function pageQueueDb(pageQueue: D1PageQueue): D1Database {
	return (pageQueue as unknown as { db: D1Database }).db;
}

async function urls(pageQueue: D1PageQueue): Promise<string[]> {
	const rows = await pageQueueDb(pageQueue)
		.prepare("SELECT url FROM page_work ORDER BY url ASC")
		.all<{ url: string }>();
	return rows.results.map((row) => row.url);
}
