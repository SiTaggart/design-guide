import { describe, expect, it } from "vitest";
import { SEED_HASH } from "../src/index/seed-hash.ts";
import { readParks, writePark } from "../src/index/parks.ts";
import { writeLastIndexedHashIfComplete } from "../src/index/indexed-hashes.ts";
import { finishIndexMail } from "../src/index/mail.ts";
import { finishStatusRun, readStatus, runStateFrom, startStatusRun, writeStatus } from "../src/index/status.ts";
import { persistSystemOutcome } from "../src/index/trigger.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV, mockWorkflow } from "./helpers/index-env.ts";

const STATUS_TOKEN = "test-status-token";

function authed(url: string): Request {
	return new Request(url, { headers: { authorization: `Bearer ${STATUS_TOKEN}` } });
}

describe("GET /v1/index-status", () => {
	it("returns unbound 200 when INDEX is missing", async () => {
		const { env } = envWithIndex(fixtureChunks);
		const response = await worker.fetch(authed("https://example.test/v1/index-status"), {
			...env,
			STATUS_TOKEN,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			unbound: true,
			workflowId: null,
			seedHash: SEED_HASH,
			lastIndexedHash: null,
			parks: {},
			unparked: [],
			systems: [],
			errors: { crawl: [], render: [], index: [] },
			counts: { systems: 0, indexed: 0, parked: 0, errors: 0 },
			queue: { pending: 0, claimed: 0, failed: 0, done: 0 },
			freshness: [],
			discover: null,
		});
	});

	it("returns last-run JSON with parks, errors, and workflow id", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-drift-test" });
		await writeStatus(env, {
			unbound: false,
			workflowId: "reindex-drift-test",
			trigger: "deploy-drift",
			state: "fail",
			startedAt: "2026-09-27T00:00:00.000Z",
			finishedAt: "2026-09-27T00:10:00.000Z",
			seedHash: SEED_HASH,
			lastIndexedHash: null,
			parks: {},
			unparked: [],
			systems: [
				{
					system: "garden",
					startUrl: "https://garden.zendesk.com/",
					crawl: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					parked: true,
					usable: 1,
					error: "stub: only 1 usable page(s)",
				},
				{
					system: "primer",
					startUrl: "https://primer.style/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable: 0,
					error: "item upload failed primer/x.md: boom",
				},
			],
			errors: { crawl: [], render: [], index: [] },
			counts: { systems: 0, indexed: 0, parked: 0, errors: 0 },
			queue: { pending: 0, claimed: 0, failed: 0, done: 0 },
			freshness: [],
			discover: null,
		});
		const response = await worker.fetch(authed("https://example.test/v1/index-status"), {
			...env,
			STATUS_TOKEN,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			unbound: boolean;
			workflowId: string;
			parks: { garden: { reason: string } };
			errors: { index: Array<{ system: string }>; crawl: unknown[] };
			counts: { parked: number; errors: number; systems: number };
		};
		expect(body.unbound).toBe(false);
		expect(body.workflowId).toBe("reindex-drift-test");
		expect(body.parks.garden.reason).toBe("stub");
		expect(body.errors.index).toEqual([
			{ system: "primer", message: "item upload failed primer/x.md: boom" },
		]);
		expect(body.errors.crawl).toEqual([]);
		expect(body.counts.parked).toBe(1);
		expect(body.counts.errors).toBe(1);
		expect(body.counts.systems).toBe(2);
	});

	it("does not let a second workflow clobber a running last-run", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-drift-live", existingStatus: "running" });
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, REINDEX: workflow.binding });
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-drift-live" });
		const started = await startStatusRun(env, { trigger: "recrawl", workflowId: "reindex-mail-proof" });
		expect(started.workflowId).toBe("reindex-drift-live");
		expect(started.trigger).toBe("deploy-drift");
		expect(started.state).toBe("running");

		const finished = await finishStatusRun(
			env,
			[
				{
					system: "primer",
					startUrl: "https://primer.style/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable: 0,
					error: "should not write",
				},
			],
			"2026-09-27T01:00:00.000Z",
			"reindex-mail-proof",
		);
		expect(finished.workflowId).toBe("reindex-drift-live");
		expect(finished.state).toBe("running");
		expect(finished.systems).toEqual([]);
	});

	it("records a run-level setup fail as fail, not ok", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		const finished = await finishStatusRun(env, [], "2026-09-27T01:00:00.000Z", "reindex-setup-fail", "sweep boom");
		expect(finished.state).toBe("fail");
		expect(finished.runError).toBe("sweep boom");
		expect(finished.workflowId).toBe("reindex-setup-fail");
		expect(finished.errors.crawl).toEqual([{ message: "sweep boom" }]);
		expect(finished.counts.errors).toBe(1);
		const response = await worker.fetch(authed("https://example.test/v1/index-status"), {
			...env,
			STATUS_TOKEN,
		});
		const body = (await response.json()) as {
			state: string;
			runError?: string;
			errors: { crawl: Array<{ message: string }> };
		};
		expect(body.state).toBe("fail");
		expect(body.runError).toBe("sweep boom");
		expect(body.errors.crawl).toEqual([{ message: "sweep boom" }]);
	});

	it("replaces last-run when the stored workflow id is no longer live", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-drift-dead", existingStatus: "errored" });
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, REINDEX: workflow.binding });
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-drift-dead" });
		const started = await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-drift-next" });
		expect(started.workflowId).toBe("reindex-drift-next");
		expect(started.state).toBe("running");
	});

	it("clears a park and lists unparked after a recovery swap", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "recovery", workflowId: "reindex-recovery-unpark" });
		await persistSystemOutcome(env, {
			system: "garden",
			startUrl: "https://garden.zendesk.com/",
			crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 2,
			hitLimit: false,
			keptPrevious: false,
			parked: false,
			usable: 2,
		});
		const finished = await finishStatusRun(
			env,
			[
				{
					system: "garden",
					startUrl: "https://garden.zendesk.com/",
					crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 2,
					hitLimit: false,
					keptPrevious: false,
					parked: false,
					usable: 2,
				},
			],
			"2026-09-27T06:10:00.000Z",
			"reindex-recovery-unpark",
		);
		expect(await readParks(env)).toEqual({ kind: "ok", parks: {} });
		expect((await readStatus(env)).unparked).toEqual(["garden"]);
		expect(finished.trigger).toBe("recovery");
		expect(finished.unparked).toEqual(["garden"]);
		expect(finished.parks).toEqual({});
		expect(finished.state).toBe("ok");
		const response = await worker.fetch(authed("https://example.test/v1/index-status"), {
			...env,
			STATUS_TOKEN,
		});
		const body = (await response.json()) as {
			trigger: string;
			unparked: string[];
			parks: Record<string, unknown>;
		};
		expect(body.trigger).toBe("recovery");
		expect(body.unparked).toEqual(["garden"]);
		expect(body.parks).toEqual({});
	});

	it("keeps a still-stub recovery parked and does not fail the run", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "recovery", workflowId: "reindex-recovery-stub" });
		const stub = {
			system: "garden" as const,
			startUrl: "https://garden.zendesk.com/",
			crawl: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			parked: true,
			usable: 1,
			error: "stub: only 1 usable page(s)",
		};
		await persistSystemOutcome(env, stub);
		const finished = await finishStatusRun(env, [stub], "2026-09-27T06:10:00.000Z", "reindex-recovery-stub");
		expect(await readParks(env)).toEqual({
			kind: "ok",
			parks: { garden: expect.objectContaining({ reason: "stub", usable: 1 }) },
		});
		expect((await readStatus(env)).unparked).toEqual([]);
		expect(finished.state).toBe("ok");
		expect(runStateFrom([stub])).toBe("ok");
	});

	it("leaves a failed recovery parked", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "recovery", workflowId: "reindex-recovery-fail" });
		const failed = {
			system: "garden" as const,
			startUrl: "https://garden.zendesk.com/",
			crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			usable: 0,
			error: "crawl ended failed",
		};
		await persistSystemOutcome(env, failed);
		expect(await readParks(env)).toEqual({
			kind: "ok",
			parks: { garden: { reason: "stub", usable: 1, at: "2026-09-27T00:00:00.000Z" } },
		});
		expect((await readStatus(env)).unparked).toEqual([]);
	});

	it("reports fail and does not commit the catalog when non-parked systems indexed nothing", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "vanilla", 1, "2026-09-27T00:00:00.000Z");
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-drift-empty" });
		const parked = {
			system: "vanilla" as const,
			startUrl: "https://vanillaframework.io/docs/",
			crawl: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			parked: true,
			usable: 1,
			error: "stub: only 1 usable page(s)",
		};
		const failed = {
			system: "primer" as const,
			startUrl: "https://primer.style/",
			crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			usable: 0,
			error: "item upload failed primer/gen/a.md: [{\"code\":7009,\"message\":\"Upstream service unavailable\"}]",
		};
		await persistSystemOutcome(env, parked);
		await persistSystemOutcome(env, failed);
		await writeLastIndexedHashIfComplete(env);
		const finished = await finishStatusRun(env, [parked, failed], "2026-09-27T23:00:00.000Z", "reindex-drift-empty");
		expect(finished.state).toBe("fail");
		expect(finished.counts).toMatchObject({ indexed: 0, errors: 1 });
		expect(finished.lastIndexedHash).toBeNull();
		const mail = finishIndexMail(
			{ trigger: "deploy-drift", workflowId: "reindex-drift-empty" },
			[parked, failed],
			finished.parks,
		);
		expect(mail.subject).toBe("design-guide index finished fail (deploy-drift) reindex-drift-empty");
		expect(mail.text).toContain("State: fail");
		expect(mail.text).toContain("indexed=0");
	});
});
