import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_CRAWL_DEPTH, BROWSER_CRAWL_LIMIT, CRAWL_RUNAWAY_PAGES } from "../src/config/instance.ts";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS, type SystemId } from "../src/config/types.ts";
import { crawlRequestBody } from "../src/crawl/browser-run.ts";
import { discoverTick } from "../src/index/discover.ts";
import { drainTick } from "../src/index/drain.ts";
import { fillTick } from "../src/index/fill.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { D1PageQueue, FRESHNESS_MS } from "../src/index/page-queue.ts";
import { writePark } from "../src/index/parks.ts";
import { systemSeedHash } from "../src/index/seed-hash.ts";
import { DRIFT_CRON } from "../src/index/trigger.ts";
import * as itemsRest from "../src/index/items-rest.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1, stampClaim } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function ago(days: number): string {
	return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function indexed(
	queue: D1PageQueue,
	systemId: SystemId,
	url: string,
	at: string,
): Promise<void> {
	await queue.enqueueUpsert([{ systemId, url, kind: "seed" }], at);
	await queue.complete(await stampClaim(queue, systemId, url, at), { lastCrawled: at, lastIndexed: at }, `${systemId}/page/old.md`);
}

describe("scheduled recrawl", () => {
	it("keeps the freshness window at 30 days", () => {
		expect(FRESHNESS_MS).toBe(30 * DAY_MS);
		expect(DRIFT_CRON).toBe("*/5 * * * *");
	});

	it("picks a live system indexed 31 days ago on the next five-minute tick, and not one indexed 29 days ago", async () => {
		const stale = await catalog({ pasteDays: 31 });
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/browser-rendering/crawl")) {
					bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return json(200, { result: "job-recrawl" });
				}
				return json(500, { errors: [{ message: `unexpected ${String(input)}` }] });
			}),
		);
		await fillTick(stale.env, DRIFT_CRON, new Date(NOW));
		expect((await stale.queue.running())?.systemId).toBe("paste");
		const running = await stale.queue.running();
		expect(running?.kind).toBe("reindex");
		expect(running?.trigger).toBe("recrawl");
		expect(running?.startUrl).toBe(seedById("paste").startUrl);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.limit).toBe(100_000);
		expect(bodies[0]?.depth).toBe(100_000);
		expect(bodies[0]?.source).toBe("all");
		expect(bodies[0]).toEqual(crawlRequestBody(seedById("paste"), seedById("paste").startUrl));
		expect(BROWSER_CRAWL_LIMIT).toBe(100_000);
		expect(BROWSER_CRAWL_DEPTH).toBe(100_000);
		expect(CRAWL_RUNAWAY_PAGES).toBe(10_000);

		const fresh = await catalog({ pasteDays: 29 });
		await fillTick(fresh.env, DRIFT_CRON, new Date(NOW));
		expect(await fresh.queue.running()).toBeNull();
	});

	it("re-enqueues every page a completed recrawl fetches, then drain writes a new index time", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const keep = "https://paste-dsys.com/components/button";
		const removed = "https://paste-dsys.com/components/removed";
		const added = "https://paste-dsys.com/components/alert";
		await indexed(queue, "paste", keep, ago(31));
		await indexed(queue, "paste", removed, ago(31));
		await queue.insertRun({
			systemId: "paste",
			kind: "reindex",
			trigger: "recrawl",
			jobId: "job-recrawl",
			startUrl: seedById("paste").startUrl,
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		const deleted: string[] = [];
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([
			{ id: "keep-doc", key: "paste/old/keep.md", metadata: { system: "paste", source_url: keep } },
			{ id: "removed-doc", key: "paste/old/removed.md", metadata: { system: "paste", source_url: removed } },
		]);
		vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
			deleted.push(id);
		});
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const finished = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 4, total: 4 }),
			page: async () => ({
				records: [
					{ url: keep, status: "completed", markdown: "# button changed" },
					{ url: added, status: "completed", markdown: "# alert" },
				],
				cursor: null,
			}),
			cancel: async () => undefined,
		});
		expect(finished).toMatchObject({
			action: "enqueued",
			systemId: "paste",
			kind: "reindex",
			trigger: "recrawl",
			incomplete: false,
			pruned: [removed],
		});
		expect(deleted).toEqual(["removed-doc"]);
		const queued = await db
			.prepare("SELECT url, status FROM page_work WHERE system_id = ? ORDER BY url ASC")
			.bind("paste")
			.all<{ url: string; status: string }>();
		expect(queued.results).toEqual([
			{ url: added, status: "pending" },
			{ url: keep, status: "pending" },
		]);

		const uploaded: string[] = [];
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockImplementation(async (_auth, _key, _content, metadata) => {
			uploaded.push(metadata.source_url ?? "");
			return { id: "fresh", key: "paste/page/fresh.md" };
		});
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([]);
		const drained = await drainTick({
			queue,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async () => "# button changed",
		});
		expect(drained.indexed).toBe(2);
		expect(uploaded.sort()).toEqual([added, keep]);
		const stamped = await db
			.prepare("SELECT url, status, last_indexed FROM page_work WHERE system_id = ? ORDER BY url ASC")
			.bind("paste")
			.all<{ url: string; status: string; last_indexed: string }>();
		expect(stamped.results).toEqual([
			{ url: added, status: "done", last_indexed: NOW },
			{ url: keep, status: "done", last_indexed: NOW },
		]);
	});

	it("does not drop pages or move the 30-day clock when a recrawl is capped", async () => {
		await cappedRecrawlClock();
	});

	it("does not drop pages or record a refresh when a recrawl hits the page ceiling", async () => {
		await ceilingRecrawl();
	});

	it("does not drop pages or move the 30-day clock when a recrawl follow-up start fails", async () => {
		await failedFollowUpRecrawl();
	});

	it("starts a permanently capped system at most four times in seven days and still discovers another drifted system", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			if (id === "paste" || id === "primer") {
				continue;
			}
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
			await indexed(queue, id, `${seedById(id).startUrl}page`, ago(1));
			await indexed(queue, id, `${seedById(id).startUrl}other`, ago(1));
		}
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([]);
		vi.spyOn(itemsRest, "deleteItem").mockResolvedValue();
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "page.md" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (String(input).includes("/browser-rendering/markdown")) {
					return json(200, { result: "# page" });
				}
				return json(200, { result: {} });
			}),
		);
		const starts: string[] = [];
		const deps = {
			start: async (_auth: unknown, seed: { id: string; startUrl: string }) => {
				starts.push(seed.id);
				return { startUrl: seed.startUrl, jobId: `job-${seed.id}-${starts.length}` };
			},
			poll: async (_auth: unknown, jobId: string) => {
				if (jobId.startsWith("job-paste-")) {
					return { status: "cancelled_due_to_limits" as const, finished: 100_000, total: 100_000 };
				}
				return { status: "completed" as const, finished: 2, total: 2 };
			},
			page: async (_auth: unknown, jobId: string) => {
				const system = jobId.startsWith("job-paste-") ? "paste" : "primer";
				const origin = seedById(system).startUrl.replace(/\/$/, "");
				return {
					records: [
						{ url: `${origin}/components/one`, status: "completed", markdown: "# one" },
						{ url: `${origin}/components/two`, status: "completed", markdown: "# two" },
					],
					cursor: null,
				};
			},
			cancel: async () => undefined,
		};
		const week = 7 * 24 * HOUR_MS;
		for (let elapsed = 0; elapsed <= week; elapsed += HOUR_MS) {
			await fillTick(env, DRIFT_CRON, new Date(Date.parse(NOW) + elapsed), deps);
		}
		const pasteStarts = starts.filter((id) => id === "paste");
		expect(pasteStarts.length).toBeGreaterThan(1);
		expect(pasteStarts.length).toBeLessThanOrEqual(4);
		expect(starts).toContain("primer");
	});

	it("starts a system whose follow-up always errors at most four times in seven days", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			if (id === "paste") {
				continue;
			}
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
			await indexed(queue, id, `${seedById(id).startUrl}page`, ago(1));
			await indexed(queue, id, `${seedById(id).startUrl}other`, ago(1));
		}
		vi.spyOn(itemsRest, "listItems").mockResolvedValue([]);
		vi.spyOn(itemsRest, "deleteItem").mockResolvedValue();
		vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
		vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
		vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "page.md" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (String(input).includes("/browser-rendering/markdown")) {
					return json(200, { result: "# page" });
				}
				return json(200, { result: {} });
			}),
		);
		const roots: string[] = [];
		const deps = {
			start: async (_auth: unknown, seed: { id: string; startUrl: string }, startUrl?: string) => {
				const follow = startUrl !== undefined;
				if (!follow) {
					roots.push(seed.id);
				}
				return {
					startUrl: startUrl ?? seed.startUrl,
					jobId: follow ? `job-${seed.id}:follow:${roots.length}` : `job-${seed.id}:root:${roots.length}`,
				};
			},
			poll: async (_auth: unknown, jobId: string) => {
				if (jobId.includes(":follow:")) {
					return { status: "errored" as const, finished: 1, total: 1 };
				}
				return { status: "completed" as const, finished: 2, total: 2 };
			},
			page: async () => ({
				records: [
					{
						url: "https://paste-dsys.com/components/form",
						status: "completed",
						markdown: "See [button](https://paste-dsys.com/components/button).",
					},
					{ url: "https://paste-dsys.com/components/input", status: "completed", markdown: "# input" },
				],
				cursor: null,
			}),
			cancel: async () => undefined,
		};
		const week = 7 * 24 * HOUR_MS;
		for (let elapsed = 0; elapsed <= week; elapsed += HOUR_MS) {
			await fillTick(env, DRIFT_CRON, new Date(Date.parse(NOW) + elapsed), deps);
		}
		expect(roots.filter((id) => id === "paste").length).toBeGreaterThan(1);
		expect(roots.filter((id) => id === "paste").length).toBeLessThanOrEqual(4);
	});

	it("clears the backoff streak on a complete run so the next incomplete waits one hour", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			if (id === "paste") {
				continue;
			}
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
			await indexed(queue, id, `${seedById(id).startUrl}page`, ago(1));
			await indexed(queue, id, `${seedById(id).startUrl}other`, ago(1));
		}
		let capped = true;
		const starts: string[] = [];
		const deps = {
			start: async (_auth: unknown, seed: { id: string; startUrl: string }) => {
				starts.push(seed.id);
				return { startUrl: seed.startUrl, jobId: `job-${starts.length}` };
			},
			poll: async () =>
				capped
					? { status: "cancelled_due_to_limits" as const, finished: 100_000, total: 100_000 }
					: { status: "completed" as const, finished: 2, total: 2 },
			page: async () => ({
				records: [
					{ url: "https://paste-dsys.com/components/one", status: "completed", markdown: "# one" },
					{ url: "https://paste-dsys.com/components/two", status: "completed", markdown: "# two" },
				],
				cursor: null,
			}),
			cancel: async () => undefined,
		};
		const tick = async (elapsed: number) => {
			await discoverTick(env, DRIFT_CRON, new Date(Date.parse(NOW) + elapsed), deps);
			await db.prepare("UPDATE page_work SET status = 'done', claimed_at = NULL WHERE system_id = 'paste'").run();
		};
		const streak = async () => {
			const row = await db
				.prepare("SELECT streak FROM cap_defer WHERE system_id = ?")
				.bind("paste")
				.first<{ streak: number }>();
			return row?.streak ?? null;
		};
		await tick(0);
		await tick(HOUR_MS);
		expect(starts).toEqual(["paste"]);
		expect(await streak()).toBe(1);
		await tick(2 * HOUR_MS);
		await tick(3 * HOUR_MS);
		expect(starts).toEqual(["paste", "paste"]);
		expect(await streak()).toBe(2);
		await tick(4 * HOUR_MS);
		expect(starts).toEqual(["paste", "paste"]);
		capped = false;
		await tick(9 * HOUR_MS);
		await tick(10 * HOUR_MS);
		expect(starts).toEqual(["paste", "paste", "paste"]);
		expect(await streak()).toBeNull();
		capped = true;
		await tick(11 * HOUR_MS);
		await tick(12 * HOUR_MS);
		expect(starts).toEqual(["paste", "paste", "paste", "paste"]);
		expect(await streak()).toBe(1);
		await tick(12 * HOUR_MS + 30 * 60 * 1000);
		expect(starts).toEqual(["paste", "paste", "paste", "paste"]);
		await tick(13 * HOUR_MS);
		expect(starts).toEqual(["paste", "paste", "paste", "paste", "paste"]);
	});
});

async function catalog(input: { pasteDays: number }): Promise<{ env: ReturnType<typeof envWithIndex>["env"]; queue: D1PageQueue }> {
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	const kv = memoryKV();
	const { env } = envWithIndex(fixtureChunks, true, {
		INDEX: kv,
		PAGE_QUEUE: db,
		CLOUDFLARE_ACCOUNT_ID: "acct",
		CLOUDFLARE_API_TOKEN: "token",
	});
	for (const id of SYSTEM_IDS) {
		await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
		const days = id === "paste" ? input.pasteDays : id === "garden" || id === "vanilla" || id === "cloudscape" ? 60 : 29;
		await indexed(queue, id, `${seedById(id).startUrl}page`, ago(days));
		await indexed(queue, id, `${seedById(id).startUrl}other`, ago(days));
	}
	await writePark(env, "garden", 1, NOW);
	await writePark(env, "vanilla", 1, NOW);
	await queue.noteCapDefer("cloudscape", NOW);
	return { env, queue };
}

async function cappedRecrawlClock(): Promise<void> {
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	const old = ago(31);
	const keep = "https://paste-dsys.com/components/button";
	const removed = "https://paste-dsys.com/components/removed";
	await indexed(queue, "paste", keep, old);
	await indexed(queue, "paste", removed, old);
	for (const id of SYSTEM_IDS) {
		if (id === "paste") {
			continue;
		}
		await indexed(queue, id, `${seedById(id).startUrl}page`, ago(1));
	}
	await queue.insertRun({
		systemId: "paste",
		kind: "reindex",
		trigger: "recrawl",
		jobId: "job-capped",
		startUrl: seedById("paste").startUrl,
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
	for (const id of SYSTEM_IDS) {
		await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
	}
	const deleted: string[] = [];
	vi.spyOn(itemsRest, "listItems").mockResolvedValue([
		{ id: "removed-doc", key: "paste/old/removed.md", metadata: { system: "paste", source_url: removed } },
	]);
	vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
		deleted.push(id);
	});
	vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
	vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
	vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "paste/page/fresh.md" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.includes("/browser-rendering/markdown")) {
				return json(200, { result: "# button guidance" });
			}
			if (method === "GET" && url.includes("/ai-search/instances/")) {
				return json(200, { result: { id: "design-guide" } });
			}
			if (method === "GET" && url.includes("/items")) {
				return json(200, { result: [], result_info: { total_count: 0 } });
			}
			if (method === "POST" && url.includes("/items")) {
				return json(200, { result: { id: "item", key: "paste/page/new.md" } });
			}
			return json(200, { result: {} });
		}),
	);
	const started: string[] = [];
	const deps = {
		start: async (_auth: unknown, seed: { id: string; startUrl: string }) => {
			started.push(seed.id);
			return { startUrl: seed.startUrl, jobId: "job-again" };
		},
		poll: async () => ({ status: "cancelled_due_to_limits" as const, finished: 100_000, total: 100_000 }),
		page: async () => ({
			records: [
				{ url: keep, status: "completed", markdown: "# button" },
				{ url: "https://paste-dsys.com/components/alert", status: "completed", markdown: "# alert" },
			],
			cursor: null,
		}),
		cancel: async () => undefined,
	};
	await fillTick(env, DRIFT_CRON, new Date(NOW), deps);
	expect(deleted).toEqual([]);
	const urls = await db
		.prepare("SELECT url FROM page_work WHERE system_id = ? AND url = ?")
		.bind("paste", removed)
		.all<{ url: string }>();
	expect(urls.results?.map((row) => row.url)).toEqual([removed]);
	expect(await queue.seedRefreshes()).toEqual({});
	const row = await db
		.prepare("SELECT status, last_indexed FROM page_work WHERE url = ?")
		.bind(keep)
		.first<{ status: string; last_indexed: string }>();
	expect(row).toEqual({ status: "done", last_indexed: old });
	const fresh = (await queue.freshness()).find((entry) => entry.system === "paste");
	expect(fresh?.lastIndexed).toBe(old);
	await fillTick(env, DRIFT_CRON, new Date(Date.parse(NOW) + 2 * HOUR_MS), deps);
	expect(started).toEqual(["paste"]);
}

async function ceilingRecrawl(): Promise<void> {
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	await db.exec(`WITH RECURSIVE n(i) AS (
		SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CRAWL_RUNAWAY_PAGES}
	) INSERT INTO discover_indexable (system_id, url)
	  SELECT 'paste', 'https://paste-dsys.com/p/' || i FROM n`);
	const removed = "https://paste-dsys.com/components/removed";
	await indexed(queue, "paste", removed, ago(31));
	await queue.insertRun({
		systemId: "paste",
		kind: "reindex",
		trigger: "recrawl",
		jobId: "job-ceiling",
		startUrl: seedById("paste").startUrl,
		cursor: null,
		pollFailures: 0,
		startedAt: NOW,
		now: NOW,
	});
	await queue.saveCursor("paste", "done", NOW);
	const { env } = envWithIndex(fixtureChunks, true, {
		INDEX: memoryKV(),
		PAGE_QUEUE: db,
		CLOUDFLARE_ACCOUNT_ID: "acct",
		CLOUDFLARE_API_TOKEN: "token",
	});
	const deleted: string[] = [];
	const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), {
		poll: async () => ({ status: "completed", finished: CRAWL_RUNAWAY_PAGES, total: CRAWL_RUNAWAY_PAGES }),
		page: async () => {
			throw new Error("a ceiling recrawl must not page further");
		},
		start: async () => {
			throw new Error("a ceiling recrawl must not start another crawl");
		},
		deleteDocs: async () => {
			deleted.push("called");
		},
		cancel: async () => undefined,
	});
	expect(result).toMatchObject({ action: "enqueued", kind: "reindex", trigger: "recrawl", incomplete: true, pruned: [] });
	expect(deleted).toEqual([]);
	expect(await queue.seedRefreshes()).toEqual({});
	const left = await db
		.prepare("SELECT url FROM page_work WHERE url = ?")
		.bind(removed)
		.all<{ url: string }>();
	expect(left.results?.map((row) => row.url)).toEqual([removed]);
}

async function failedFollowUpRecrawl(): Promise<void> {
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	const old = ago(31);
	const removed = "https://paste-dsys.com/components/removed";
	const good = "https://paste-dsys.com/components/good";
	await indexed(queue, "paste", removed, old);
	await queue.insertRun({
		systemId: "paste",
		kind: "reindex",
		trigger: "recrawl",
		jobId: "job-start",
		startUrl: seedById("paste").startUrl,
		cursor: null,
		pollFailures: 0,
		startedAt: NOW,
		now: NOW,
	});
	await queue.saveCursor("paste", "done", NOW);
	await queue.stageUrl("paste", "https://paste-dsys.com/components/form");
	await queue.stageIndexable("paste", "https://paste-dsys.com/components/form");
	await queue.stageUrl("paste", "https://paste-dsys.com/components/input");
	await queue.stageIndexable("paste", "https://paste-dsys.com/components/input");
	await queue.addFrontier("paste", [
		"https://paste-dsys.com/components/fail",
		good,
	]);
	const { env } = envWithIndex(fixtureChunks, true, {
		INDEX: memoryKV(),
		PAGE_QUEUE: db,
		CLOUDFLARE_ACCOUNT_ID: "acct",
		CLOUDFLARE_API_TOKEN: "token",
	});
	const deleted: string[] = [];
	vi.spyOn(itemsRest, "listItems").mockResolvedValue([
		{ id: "removed-doc", key: "paste/old/removed.md", metadata: { system: "paste", source_url: removed } },
	]);
	vi.spyOn(itemsRest, "deleteItem").mockImplementation(async (_auth, id) => {
		deleted.push(id);
	});
	vi.spyOn(itemsRest, "deleteItemByKey").mockResolvedValue();
	const deps = {
		poll: async () => ({ status: "completed" as const, finished: 4, total: 4 }),
		page: async () => ({
			records: [{ url: good, status: "completed", markdown: "# good" }],
			cursor: null,
		}),
		start: async (_auth: unknown, _seed: unknown, startUrl?: string) => {
			const url = startUrl ?? "";
			if (url.includes("fail")) {
				throw new Error("429");
			}
			return { startUrl: url, jobId: "job-good" };
		},
		cancel: async () => undefined,
	};
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const result = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
		expect(result).toMatchObject({ action: "continued" });
	}
	const moved = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
	expect(moved).toMatchObject({ action: "continued" });
	const finished = await discoverTick(env, DRIFT_CRON, new Date(NOW), deps);
	expect(finished).toMatchObject({ action: "enqueued", incomplete: true, pruned: [] });
	expect(deleted).toEqual([]);
	expect(await queue.seedRefreshes()).toEqual({});
	const left = await db
		.prepare("SELECT url FROM page_work WHERE url = ?")
		.bind(removed)
		.all<{ url: string }>();
	expect(left.results?.map((row) => row.url)).toEqual([removed]);
	vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
	vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "paste/page/fresh.md" });
	vi.spyOn(itemsRest, "listItems").mockResolvedValue([]);
	const drained = await drainTick({
		queue,
		auth: { accountId: "acct", apiToken: "token" },
		now: NOW,
		fetchMarkdown: async () => "# good",
	});
	expect(drained.indexed).toBeGreaterThan(0);
	const clock = (await queue.freshness()).find((entry) => entry.system === "paste");
	expect(clock?.lastIndexed).toBe(old);
}
