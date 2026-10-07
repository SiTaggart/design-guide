import { describe, expect, it } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { writePark } from "../src/index/parks.ts";
import { SEED_HASH } from "../src/index/seed-hash.ts";
import { emptyStatus, writeStatus, type IndexStatusDocument } from "../src/index/status.ts";
import { queueMotion, renderStatusPage, systemPhase } from "../src/serve/status-page.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const STATUS_TOKEN = "test-status-token";
const NOW = "2026-09-30T12:00:00.000Z";

function authed(url: string, token = STATUS_TOKEN): Request {
	return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

function row(html: string, system: string): string {
	const match = html.match(new RegExp(`<tr data-system="${system}"[\\s\\S]*?</tr>`));
	expect(match, system).not.toBeNull();
	return match?.[0] ?? "";
}

describe("status token gate", () => {
	it("returns 401 for /status, /v1/index-status, and /v1/fill-health without a token", async () => {
		const { env } = envWithIndex(fixtureChunks, true, { STATUS_TOKEN, INDEX: memoryKV() });
		for (const path of ["/status", "/v1/index-status", "/v1/fill-health"]) {
			const response = await worker.fetch(new Request(`https://example.test${path}`), env);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
	});

	it("returns 401 for a wrong token and when STATUS_TOKEN is unset", async () => {
		const { env } = envWithIndex(fixtureChunks, true, { STATUS_TOKEN, INDEX: memoryKV() });
		const wrong = await worker.fetch(authed("https://example.test/status", "nope"), env);
		expect(wrong.status).toBe(401);

		const { env: open } = envWithIndex(fixtureChunks, true, { INDEX: memoryKV() });
		const missing = await worker.fetch(authed("https://example.test/v1/index-status"), open);
		expect(missing.status).toBe(401);
	});

	it("accepts Bearer or ?token= and leaves search, mcp, and health public", async () => {
		const { env } = envWithIndex(fixtureChunks, true, { STATUS_TOKEN, INDEX: memoryKV() });
		const bearer = await worker.fetch(authed("https://example.test/v1/index-status"), env);
		expect(bearer.status).toBe(200);
		const query = await worker.fetch(
			new Request(`https://example.test/status?token=${STATUS_TOKEN}`),
			env,
		);
		expect(query.status).toBe(200);
		expect(query.headers.get("content-type")).toContain("text/html");

		const health = await worker.fetch(new Request("https://example.test/health"), env);
		expect(health.status).toBe(200);
		const search = await worker.fetch(new Request("https://example.test/v1/search?query=combobox"), env);
		expect(search.status).toBe(200);
		const mcp = await worker.fetch(new Request("https://example.test/mcp"), env);
		expect(mcp.status).not.toBe(401);
	});
});

describe("GET /status", () => {
	it("reads live discover and renders the same document as /v1/index-status", async () => {
		const kv = memoryKV();
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		await queue.ensure();
		await queue.enqueueUpsert(
			[
				{ systemId: "primer", url: "https://primer.style/a", kind: "reindex" },
				{ systemId: "primer", url: "https://primer.style/b", kind: "reindex" },
				{ systemId: "uswds", url: "https://designsystem.digital.gov/a", kind: "reindex" },
				{ systemId: "paste", url: "https://paste-dsys.com/a", kind: "seed" },
			],
			NOW,
		);
		await db
			.prepare("UPDATE page_work SET status = 'failed', error = ? WHERE system_id = ?")
			.bind("render failed", "uswds")
			.run();
		await db
			.prepare("UPDATE page_work SET status = 'claimed', claimed_at = ? WHERE system_id = ? AND url = ?")
			.bind(NOW, "primer", "https://primer.style/b")
			.run();
		await queue.complete(
			{ systemId: "paste", url: "https://paste-dsys.com/a" },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"paste/key",
		);
		await queue.markDiscovered("paste", NOW);
		await queue.insertRun({
			systemId: "primer",
			kind: "reindex",
			trigger: "recrawl",
			jobId: "job-primer-1",
			startUrl: "https://primer.style/",
			cursor: null,
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});

		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, PAGE_QUEUE: db, STATUS_TOKEN });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await writeStatus(env, {
			...emptyStatus(false),
			workflowId: "discover-recrawl-primer",
			trigger: "recrawl",
			state: "running",
			startedAt: NOW,
			finishedAt: null,
			seedHash: SEED_HASH,
			systems: [
				{
					system: "uswds",
					startUrl: "https://designsystem.digital.gov/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 1 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable: 0,
					error: "crawl ended failed",
				},
			],
			discover: {
				systemId: "garden",
				jobId: "stale-kv-job",
				kind: "seed",
				trigger: "deploy-drift",
				startedAt: "2020-01-01T00:00:00.000Z",
			},
		});

		const jsonResponse = await worker.fetch(authed("https://example.test/v1/index-status"), env);
		const htmlResponse = await worker.fetch(authed("https://example.test/status"), env);
		expect(jsonResponse.status).toBe(200);
		expect(htmlResponse.status).toBe(200);
		const body = (await jsonResponse.json()) as IndexStatusDocument;
		const html = await htmlResponse.text();

		expect(body.discover).toEqual({
			systemId: "primer",
			jobId: "job-primer-1",
			kind: "reindex",
			trigger: "recrawl",
			startedAt: NOW,
		});
		expect(body.state).toBe("running");
		expect(body.trigger).toBe("recrawl");
		expect(body.queue).toEqual({ pending: 1, claimed: 1, failed: 1, done: 1 });
		expect(body.runError).toBeUndefined();
		expect(html).not.toContain(STATUS_TOKEN);
		expect(html).not.toContain("stale-kv-job");
		expect(html).toContain('data-queue="filling"');
		expect(html).not.toContain("Queue stuck");
		expect(html).toContain("Filling.");
		for (const field of [
			["state", body.state],
			["trigger", body.trigger],
			["startedAt", body.startedAt],
			["counts.systems", body.counts.systems],
			["counts.indexed", body.counts.indexed],
			["counts.parked", body.counts.parked],
			["counts.errors", body.counts.errors],
			["queue.pending", body.queue.pending],
			["queue.claimed", body.queue.claimed],
			["queue.failed", body.queue.failed],
			["queue.done", body.queue.done],
			["discover.systemId", body.discover?.systemId],
			["discover.jobId", body.discover?.jobId],
			["discover.kind", body.discover?.kind],
			["discover.trigger", body.discover?.trigger],
			["discover.startedAt", body.discover?.startedAt],
		] as const) {
			expect(html).toContain(`data-field="${field[0]}">${field[1]}`);
		}
		for (const id of SYSTEM_IDS) {
			expect(html).toContain(`data-system="${id}"`);
		}
		expect(row(html, "primer")).toContain('data-phase="mid-fill"');
		expect(row(html, "primer")).not.toContain(">Stuck<");
		expect(row(html, "primer")).toContain(`data-field="pending">1`);
		expect(row(html, "primer")).toContain(`data-field="claimed">1`);
		expect(row(html, "uswds")).toContain('data-phase="stuck"');
		expect(row(html, "uswds")).toContain("crawl ended failed");
		expect(row(html, "garden")).toContain('data-phase="parked"');
		expect(row(html, "garden")).toContain("park stub usable 1");
		expect(row(html, "paste")).toContain('data-phase="live"');
		expect(row(html, "paste")).toContain(`data-field="lastIndexed">${NOW}`);
		expect(row(html, "antd")).toContain('data-phase="empty"');
		expect(html.toLowerCase()).not.toContain("<form");
		expect(html.toLowerCase()).not.toContain("<button");
		expect(html.toLowerCase()).not.toContain("<script");
		expect(html.toLowerCase()).not.toContain("http-equiv");
		expect(html.toLowerCase()).not.toContain('method="post"');
	});

	it("reports discover null when no D1 run is open", async () => {
		const { env } = envWithIndex(fixtureChunks, true, {
			STATUS_TOKEN,
			INDEX: memoryKV(),
			PAGE_QUEUE: memoryD1(),
		});
		const response = await worker.fetch(authed("https://example.test/v1/index-status"), env);
		const body = (await response.json()) as IndexStatusDocument;
		expect(body.discover).toBeNull();
		const html = await (await worker.fetch(authed("https://example.test/status"), env)).text();
		expect(html).toContain('data-discover="none"');
		expect(html).toContain("No active discover");
	});

	it("rejects writes on /status and /v1/index-status", async () => {
		const kv = memoryKV();
		const db = memoryD1();
		await new D1PageQueue(db).ensure();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, PAGE_QUEUE: db, STATUS_TOKEN });
		await writeStatus(env, { ...emptyStatus(false), state: "ok", trigger: "recrawl" });
		const before = kv.store.get("status");
		for (const path of ["/status", "/v1/index-status", "/v1/fill-health"]) {
			const response = await worker.fetch(
				new Request(`https://example.test${path}`, {
					method: "POST",
					headers: { authorization: `Bearer ${STATUS_TOKEN}`, "content-type": "application/json" },
					body: JSON.stringify({ reindex: true }),
				}),
				env,
			);
			expect(response.status).toBe(405);
			expect(await response.json()).toEqual({ error: "method_not_allowed" });
		}
		expect(kv.store.get("status")).toBe(before);
		const queued = await db.prepare("SELECT COUNT(*) AS n FROM page_work").first<{ n: number }>();
		expect(queued?.n ?? 0).toBe(0);
	});
});

describe("stuck versus mid-fill", () => {
	it("keeps a moving queue out of the stuck treatment", () => {
		expect(queueMotion({ pending: 2, claimed: 0, failed: 4 })).toBe("filling");
		expect(queueMotion({ pending: 0, claimed: 1, failed: 4 })).toBe("filling");
		expect(queueMotion({ pending: 0, claimed: 0, failed: 4 })).toBe("stuck");
		expect(
			systemPhase({
				parked: false,
				pending: 2,
				claimed: 1,
				failed: 4,
				done: 0,
				lastCrawled: null,
				lastIndexed: null,
				lastDiscovered: null,
				error: "crawl ended failed",
			}),
		).toBe("mid-fill");
		expect(
			systemPhase({
				parked: false,
				pending: 0,
				claimed: 0,
				failed: 4,
				done: 0,
				lastCrawled: null,
				lastIndexed: null,
				lastDiscovered: null,
			}),
		).toBe("stuck");

		const html = renderStatusPage({
			...emptyStatus(false),
			state: "running",
			trigger: "recrawl",
			queue: { pending: 2, claimed: 0, failed: 4, done: 0 },
			freshness: [
				{
					system: "primer",
					lastCrawled: null,
					lastIndexed: null,
					lastDiscovered: null,
					pending: 2,
					claimed: 0,
					failed: 4,
					done: 0,
				},
			],
		});
		expect(html).toContain('data-queue="filling"');
		expect(html).not.toContain("Queue stuck");
		expect(row(html, "primer")).toContain('data-phase="mid-fill"');
		expect(row(html, "primer")).not.toContain(">Stuck<");
	});

	it("does not paint Live over a current error when older pages were indexed", () => {
		expect(
			systemPhase({
				parked: false,
				pending: 0,
				claimed: 0,
				failed: 0,
				done: 3,
				lastCrawled: "2026-09-30T12:00:00.000Z",
				lastIndexed: "2026-09-30T12:05:00.000Z",
				lastDiscovered: "2026-09-30T12:00:00.000Z",
				error: "crawl ended failed",
			}),
		).toBe("stuck");

		const html = renderStatusPage({
			...emptyStatus(false),
			state: "fail",
			trigger: "recrawl",
			queue: { pending: 0, claimed: 0, failed: 0, done: 3 },
			systems: [
				{
					system: "primer",
					startUrl: "https://primer.style/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 1 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable: 0,
					error: "crawl ended failed",
				},
			],
			freshness: [
				{
					system: "primer",
					lastCrawled: "2026-09-30T12:00:00.000Z",
					lastIndexed: "2026-09-30T12:05:00.000Z",
					lastDiscovered: "2026-09-30T12:00:00.000Z",
					pending: 0,
					claimed: 0,
					failed: 0,
					done: 3,
				},
			],
		});
		const primer = row(html, "primer");
		expect(primer).toContain('data-phase="stuck"');
		expect(primer).not.toContain(">Live<");
		expect(primer).toContain("crawl ended failed");
	});

	it("shows a drained crawl cap as Live with the page count and limit", () => {
		const freshness = [
			{
				system: "paste" as const,
				lastCrawled: "2026-10-07T19:55:09.039Z",
				lastIndexed: "2026-10-07T19:55:09.039Z",
				lastDiscovered: null,
				pending: 0,
				claimed: 0,
				failed: 0,
				done: 513,
			},
		];
		const queue = { pending: 0, claimed: 0, failed: 0, done: 513 };
		const base = {
			system: "paste" as const,
			startUrl: "https://paste-dsys.com/",
			crawl: { total: 533, finished: 533, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: true,
			keptPrevious: true,
			usable: 513,
		};
		for (const system of [base, { ...base, error: "crawl hit the 500 page limit" }]) {
			const html = renderStatusPage({
				...emptyStatus(false),
				state: "running",
				trigger: "deploy-drift",
				queue,
				systems: [system],
				freshness,
			});
			const paste = row(html, "paste");
			expect(paste).toContain('data-phase="live"');
			expect(paste).not.toContain(">Stuck<");
			expect(paste).toContain("cap hit: 513 pages, limit 500");
			expect(paste).not.toContain("crawl hit the 500 page limit");
		}
	});

	it("paints Live after recovery once the current error is gone", () => {
		expect(
			systemPhase({
				parked: false,
				pending: 0,
				claimed: 0,
				failed: 0,
				done: 3,
				lastCrawled: "2026-09-30T12:00:00.000Z",
				lastIndexed: "2026-09-30T12:05:00.000Z",
				lastDiscovered: "2026-09-30T12:00:00.000Z",
			}),
		).toBe("live");

		const html = renderStatusPage({
			...emptyStatus(false),
			state: "ok",
			trigger: "recrawl",
			queue: { pending: 0, claimed: 0, failed: 0, done: 3 },
			systems: [
				{
					system: "primer",
					startUrl: "https://primer.style/",
					crawl: { total: 3, finished: 3, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 3,
					hitLimit: false,
					keptPrevious: false,
					usable: 3,
				},
			],
			freshness: [
				{
					system: "primer",
					lastCrawled: "2026-09-30T12:00:00.000Z",
					lastIndexed: "2026-09-30T12:05:00.000Z",
					lastDiscovered: "2026-09-30T12:00:00.000Z",
					pending: 0,
					claimed: 0,
					failed: 0,
					done: 3,
				},
			],
		});
		const primer = row(html, "primer");
		expect(primer).toContain('data-phase="live"');
		expect(primer).not.toContain(">Stuck<");
	});

	it("makes a drained failed queue prominent", () => {
		expect(
			systemPhase({
				parked: false,
				pending: 0,
				claimed: 0,
				failed: 3,
				done: 4,
				lastCrawled: "2026-09-30T12:00:00.000Z",
				lastIndexed: "2026-09-30T12:05:00.000Z",
				lastDiscovered: null,
			}),
		).toBe("stuck");
		const html = renderStatusPage({
			...emptyStatus(false),
			state: "fail",
			trigger: "recrawl",
			runError: "queue stuck",
			queue: { pending: 0, claimed: 0, failed: 3, done: 1 },
			freshness: [
				{
					system: "antd",
					lastCrawled: null,
					lastIndexed: null,
					lastDiscovered: null,
					pending: 0,
					claimed: 0,
					failed: 3,
					done: 0,
				},
			],
		});
		expect(html).toContain('data-queue="stuck"');
		expect(html).toContain("Queue stuck");
		expect(html).toContain('data-field="runError">queue stuck');
		expect(row(html, "antd")).toContain('data-phase="stuck"');
		expect(row(html, "primer")).toContain('data-phase="empty"');
	});

	it("escapes status text", () => {
		const html = renderStatusPage({
			...emptyStatus(false),
			runError: `</script><img src=x onerror=alert(1)>`,
		});
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
	});
});
