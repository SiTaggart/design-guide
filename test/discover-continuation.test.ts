import { describe, expect, it, vi } from "vitest";
import { CRAWL_POLL_DEADLINE_MS } from "../src/crawl/browser-run.ts";
import { discoverTick } from "../src/index/discover.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const DRIFT_CRON = "*/5 * * * *";

describe("discover continuation", () => {
	it("starts another crawl from an unstaged frontier url when the job stops early", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-early",
			startUrl: "https://paste-dsys.com/",
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
		const started: string[] = [];
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "cancelled_due_to_limits", finished: 100_000, total: 100_000 }),
			page: async () => ({
				records: [
					{
						url: "https://paste-dsys.com/components/form",
						status: "completed",
						markdown: "See [button](https://paste-dsys.com/components/button).",
					},
				],
				cursor: null,
			}),
			start: async (_auth, _seed, startUrl) => {
				started.push(startUrl ?? "");
				return { startUrl: startUrl ?? "", jobId: "job-next" };
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({ action: "continued", systemId: "paste" });
		expect(started).toEqual(["https://paste-dsys.com/components/button"]);
		expect((await pageQueue.running())?.jobId).toBe("job-next");
		expect(await pageQueue.indexableCount("paste")).toBe(1);
	});

	it("marks an early stop with no frontier incomplete and does not record a seed refresh", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-no-frontier",
			startUrl: "https://paste-dsys.com/",
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
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "cancelled_due_to_limits", finished: 12, total: 12 }),
			page: async () => ({
				records: [
					{ url: "https://paste-dsys.com/a", status: "completed", markdown: "# one" },
					{ url: "https://paste-dsys.com/b", status: "completed", markdown: "# two" },
				],
				cursor: null,
			}),
			start: async () => {
				throw new Error("no frontier means no follow-up crawl");
			},
			deleteDocs: async () => {
				throw new Error("incomplete must not prune");
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			urls: 2,
			pruned: [],
			hitLimit: false,
			incomplete: true,
		});
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
	});

	it("keeps crawling when a follow-up job finishes with other frontier urls still unstaged", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-branch",
			startUrl: "https://paste-dsys.com/components/button",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.addFrontier("paste", [
			"https://paste-dsys.com/components/button",
			"https://paste-dsys.com/components/alert",
		]);
		await pageQueue.stageIndexable("paste", "https://paste-dsys.com/components/form");
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const started: string[] = [];
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 4, total: 4 }),
			page: async () => ({
				records: [
					{
						url: "https://paste-dsys.com/components/form",
						status: "completed",
						markdown: "# form",
					},
					{
						url: "https://paste-dsys.com/components/button",
						status: "completed",
						markdown: "Button guidance. See [alert](https://paste-dsys.com/components/alert).",
					},
				],
				cursor: null,
			}),
			start: async (_auth, _seed, startUrl) => {
				started.push(startUrl ?? "");
				return { startUrl: startUrl ?? "", jobId: "job-alert" };
			},
			deleteDocs: async () => {
				throw new Error("must not prune while frontier urls remain");
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({ action: "continued", systemId: "paste" });
		expect(started).toEqual(["https://paste-dsys.com/components/alert"]);
		expect((await pageQueue.running())?.jobId).toBe("job-alert");
		expect(await pageQueue.seedRefreshes()).toEqual({});
	});

	it("starts two capped jobs in a row from different urls", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-early",
			startUrl: "https://paste-dsys.com/",
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
		let pages = 0;
		const started: string[] = [];
		const deps = {
			poll: async () => ({ status: "cancelled_due_to_limits" as const, finished: 100_000, total: 100_000 }),
			page: async () => {
				pages += 1;
				if (pages === 1) {
					return {
						records: [
							{
								url: "https://paste-dsys.com/components/button/",
								status: "completed",
								markdown:
									"See https://paste-dsys.com/components/button and [alert](https://paste-dsys.com/components/alert) and [modal](https://paste-dsys.com/components/modal).",
							},
						],
						cursor: null,
					};
				}
				return { records: [], cursor: null };
			},
			start: async (_auth: unknown, _seed: unknown, startUrl?: string) => {
				const url = startUrl ?? "";
				started.push(url);
				return { startUrl: url, jobId: `job-next-${started.length}` };
			},
			cancel: async () => undefined,
		};
		const first = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
		const second = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
		expect(first).toMatchObject({ action: "continued", systemId: "paste" });
		expect(second).toMatchObject({ action: "continued", systemId: "paste" });
		expect(started).toEqual([
			"https://paste-dsys.com/components/alert",
			"https://paste-dsys.com/components/modal",
		]);
	});

	it("does not prune or record a refresh when a capped chain's follow-up completes", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const sitemapOnly = "https://paste-dsys.com/sitemap-only";
		await pageQueue.enqueueUpsert([{ systemId: "paste", url: sitemapOnly, kind: "seed" }], NOW);
		await pageQueue.complete(
			{ systemId: "paste", url: sitemapOnly },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"paste/page/sitemap-only.md",
		);
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-capped",
			startUrl: "https://paste-dsys.com/",
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
		let deleted = false;
		const first = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "cancelled_due_to_limits", finished: 100_000, total: 100_000 }),
			page: async () => ({
				records: [
					{
						url: "https://paste-dsys.com/components/form",
						status: "completed",
						markdown: "See [alert](https://paste-dsys.com/components/alert).",
					},
					{
						url: "https://paste-dsys.com/components/input",
						status: "completed",
						markdown: "# input",
					},
				],
				cursor: null,
			}),
			start: async (_auth, _seed, startUrl) => ({ startUrl: startUrl ?? "", jobId: "job-follow" }),
			deleteDocs: async () => {
				deleted = true;
			},
			cancel: async () => undefined,
		});
		expect(first).toMatchObject({ action: "continued", systemId: "paste" });
		const second = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 4, total: 4 }),
			page: async () => ({
				records: [
					{
						url: "https://paste-dsys.com/components/alert",
						status: "completed",
						markdown: "# alert",
					},
				],
				cursor: null,
			}),
			start: async () => {
				throw new Error("frontier is exhausted");
			},
			deleteDocs: async () => {
				deleted = true;
			},
			cancel: async () => undefined,
		});
		expect(second).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			incomplete: true,
			pruned: [],
		});
		expect(deleted).toBe(false);
		expect(await pageQueue.seedRefreshes()).toEqual({});
		const queued = await db
			.prepare("SELECT url FROM page_work WHERE system_id = ? AND url = ?")
			.bind("paste", sitemapOnly)
			.all<{ url: string }>();
		expect(queued.results?.map((row) => row.url)).toEqual([sitemapOnly]);
	});

	it("retries a failed follow-up start, then skips that url and keeps staged pages", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-start",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.saveCursor("paste", "done", NOW);
		await pageQueue.stageIndexable("paste", "https://paste-dsys.com/components/form");
		await pageQueue.stageIndexable("paste", "https://paste-dsys.com/components/input");
		await pageQueue.addFrontier("paste", [
			"https://paste-dsys.com/components/fail",
			"https://paste-dsys.com/components/good",
		]);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const starts: string[] = [];
		const deps = {
			poll: async () => ({ status: "completed" as const, finished: 4, total: 4 }),
			page: async () => ({ records: [], cursor: null }),
			start: async (_auth: unknown, _seed: unknown, startUrl?: string) => {
				const url = startUrl ?? "";
				starts.push(url);
				if (url.includes("fail")) {
					throw new Error("429");
				}
				return { startUrl: url, jobId: "job-good" };
			},
			cancel: async () => undefined,
		};
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
			expect(result).toMatchObject({ action: "continued", systemId: "paste" });
			expect(starts.at(-1)).toBe("https://paste-dsys.com/components/fail");
		}
		const moved = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
		expect(moved).toMatchObject({ action: "continued", systemId: "paste" });
		expect(starts.at(-1)).toBe("https://paste-dsys.com/components/good");
		expect(await pageQueue.indexableCount("paste")).toBe(2);
		expect((await pageQueue.running())?.jobId).toBe("job-good");
	});

	it("does not record a seed refresh when the run hits the page ceiling", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await db.exec(`WITH RECURSIVE n(i) AS (
			SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000
		) INSERT INTO discover_indexable (system_id, url)
		  SELECT 'paste', 'https://paste-dsys.com/p/' || i FROM n`);
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-ceiling",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.saveCursor("paste", "done", NOW);
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 10_000, total: 10_000 }),
			page: async () => {
				throw new Error("a ceiling run must not page further");
			},
			start: async () => {
				throw new Error("a ceiling run must not start another crawl");
			},
			deleteDocs: async () => {
				throw new Error("a ceiling run must not prune");
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({ action: "enqueued", systemId: "paste", incomplete: true, pruned: [] });
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
		expect(await kv.get("seedHash/paste")).toBeNull();
	});

	it("keeps staged pages when the crawl deadline passes and does not record a refresh", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const startedAt = new Date(Date.parse(NOW) - CRAWL_POLL_DEADLINE_MS - 60_000).toISOString();
		const kept = "https://paste-dsys.com/components/form";
		const also = "https://paste-dsys.com/components/input";
		const removed = "https://paste-dsys.com/components/removed";
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-deadline",
			startUrl: "https://paste-dsys.com/",
			cursor: "done",
			pollFailures: 0,
			startedAt,
			now: startedAt,
		});
		await pageQueue.stageUrl("paste", kept);
		await pageQueue.stageUrl("paste", also);
		await pageQueue.stageIndexable("paste", kept);
		await pageQueue.stageIndexable("paste", also);
		await pageQueue.enqueueUpsert([{ systemId: "paste", url: removed, kind: "seed" }], startedAt);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => {
				throw new Error("a deadline must not poll");
			},
			page: async () => {
				throw new Error("a deadline must not page");
			},
			start: async () => {
				throw new Error("a deadline must not start another crawl");
			},
			deleteDocs: async () => {
				throw new Error("a deadline must not prune");
			},
			cancel: async () => undefined,
		});
		expect(result).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			incomplete: true,
			pruned: [],
		});
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
		expect(await pageQueue.running()).toBeNull();
		const queued = await db
			.prepare("SELECT url FROM page_work WHERE system_id = ? ORDER BY url ASC")
			.bind("paste")
			.all<{ url: string }>();
		expect(queued.results?.map((row) => row.url)).toEqual([also, kept, removed]);
	});

	it("ends a run that cannot start any frontier url within a bounded number of ticks", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kept = "https://paste-dsys.com/components/form";
		const also = "https://paste-dsys.com/components/input";
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-storm",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.saveCursor("paste", "done", NOW);
		await pageQueue.stageUrl("paste", kept);
		await pageQueue.stageUrl("paste", also);
		await pageQueue.stageIndexable("paste", kept);
		await pageQueue.stageIndexable("paste", also);
		await pageQueue.addFrontier(
			"paste",
			Array.from({ length: 10 }, (_, index) => `https://paste-dsys.com/components/fail-${index}`),
		);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const deps = {
			poll: async () => ({ status: "completed" as const, finished: 4, total: 4 }),
			page: async () => ({ records: [], cursor: null }),
			start: async (_auth: unknown, _seed: unknown, startUrl?: string) => {
				throw new Error(`crawl start for ${startUrl} failed 429: slow down`);
			},
			deleteDocs: async () => {
				throw new Error("a skipped chain must not prune");
			},
			cancel: async () => undefined,
		};
		let result: Awaited<ReturnType<typeof discoverTick>> = { action: "continued", systemId: "paste", accepted: 0 };
		for (let tick = 0; tick < 20; tick += 1) {
			result = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
			if (result.action === "enqueued" || result.action === "failed") {
				break;
			}
		}
		expect(result).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			incomplete: true,
			pruned: [],
		});
		expect(await pageQueue.seedRefreshes()).toEqual({});
		expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
		const queued = await db
			.prepare("SELECT url FROM page_work WHERE system_id = ? ORDER BY url ASC")
			.bind("paste")
			.all<{ url: string }>();
		expect(queued.results?.map((row) => row.url)).toEqual([also, kept]);
	});

	it("ends a 401 follow-up start in that tick and keeps the staged pages", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const kept = "https://paste-dsys.com/components/form";
		const also = "https://paste-dsys.com/components/input";
		await pageQueue.insertRun({
			systemId: "paste",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-auth",
			startUrl: "https://paste-dsys.com/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await pageQueue.saveCursor("paste", "done", NOW);
		await pageQueue.stageUrl("paste", kept);
		await pageQueue.stageUrl("paste", also);
		await pageQueue.stageIndexable("paste", kept);
		await pageQueue.stageIndexable("paste", also);
		await pageQueue.addFrontier("paste", [
			"https://paste-dsys.com/components/fail-auth",
			"https://paste-dsys.com/components/later",
		]);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			logs.push(String(line));
		});
		const starts: string[] = [];
		try {
			const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
				poll: async () => ({ status: "completed", finished: 2, total: 2 }),
				page: async () => ({ records: [], cursor: null }),
				start: async (_auth, _seed, startUrl) => {
					const url = startUrl ?? "";
					starts.push(url);
					throw new Error(`crawl start for ${url} failed 401: unauthorized`);
				},
				deleteDocs: async () => {
					throw new Error("an unauthorized start must not prune");
				},
				cancel: async () => undefined,
			});
			expect(starts).toEqual(["https://paste-dsys.com/components/fail-auth"]);
			expect(result).toMatchObject({
				action: "enqueued",
				systemId: "paste",
				incomplete: true,
				pruned: [],
			});
			expect(logs.join("\n")).toContain("401");
			expect(await pageQueue.seedRefreshes()).toEqual({});
			expect(await pageQueue.capDefers()).toEqual({ paste: NOW });
			const queued = await db
				.prepare("SELECT url FROM page_work WHERE system_id = ? ORDER BY url ASC")
				.bind("paste")
				.all<{ url: string }>();
			expect(queued.results?.map((row) => row.url)).toEqual([also, kept]);
		} finally {
			spy.mockRestore();
		}
	});
});
