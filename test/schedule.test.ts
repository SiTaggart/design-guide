import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { seedById } from "../src/config/seed.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { writePark } from "../src/index/parks.ts";
import { SEED_HASH, systemSeedHash } from "../src/index/seed-hash.ts";
import { startStatusRun } from "../src/index/status.ts";
import { DRIFT_CRON, RECRAWL_CRON, RECOVERY_CRON, decideReindex, startReindex } from "../src/index/trigger.ts";
import { handleScheduled } from "../src/schedule.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV, mockWorkflow, parksKvGetThrows } from "./helpers/index-env.ts";

const startSeedCrawl = vi.hoisted(() =>
	vi.fn(async (_auth: unknown, seed: { startUrl: string }) => ({
		startUrl: seed.startUrl,
		jobId: "job-discover",
	})),
);

vi.mock("../src/crawl/browser-run.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/crawl/browser-run.ts")>();
	return { ...actual, startSeedCrawl };
});

describe("wrangler automation config", () => {
	const wrangler = readFileSync("wrangler.jsonc", "utf8");

	it("uses Worker crons and a 25000-step Workflow, not Workflow schedules", () => {
		expect(wrangler).toContain('"*/5 * * * *"');
		expect(wrangler).toContain('"0 4 * * *"');
		expect(wrangler).toContain('"0 6 * * SUN"');
		expect(wrangler).toContain('"steps": 25000');
		expect(wrangler).toContain('"binding": "PAGE_QUEUE"');
		expect(wrangler).not.toContain('"schedules"');
		expect(DRIFT_CRON).toBe("*/5 * * * *");
		expect(RECRAWL_CRON).toBe("0 4 * * *");
		expect(RECOVERY_CRON).toBe("0 6 * * SUN");
	});

	it("binds send_email EMAIL like team-retros, with no destination_address lock", () => {
		expect(wrangler).toContain('"send_email"');
		expect(wrangler).toContain('"name": "EMAIL"');
		expect(wrangler).not.toContain("destination_address");
	});
});

describe("decideReindex", () => {
	it("no-ops when INDEX or REINDEX is missing", async () => {
		const { env } = envWithIndex(fixtureChunks);
		expect(await decideReindex(env, DRIFT_CRON)).toEqual({ action: "skip", reason: "unbound" });
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
	});

	it("skips drift when every seed hash already matches", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
		}
		expect(await decideReindex(env, DRIFT_CRON)).toEqual({ action: "skip", reason: "no-drift" });
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
	});

	it("does not spend a drift slot on a parked seed", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
		}
		await writeIndexedHash(env, "garden", "stale");
		await writePark(env, "garden", 1);
		expect(await decideReindex(env, DRIFT_CRON)).toEqual({ action: "skip", reason: "no-drift" });
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
	});

	it("starts one live system when parked seeds sit ahead of it", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const pageQueue = memoryD1();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: pageQueue,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
		}
		await writeIndexedHash(env, "paste", "stale");
		await writeIndexedHash(env, "primer", "stale");
		await writePark(env, "paste", 1);
		const decision = await decideReindex(env, DRIFT_CRON);
		expect(decision).toEqual({
			action: "start",
			trigger: "deploy-drift",
			systems: ["primer"],
			catalogHash: SEED_HASH,
		});
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
		const running = await pageQueue
			.prepare("SELECT system_id, kind, trigger_name FROM discover_run")
			.first<{ system_id: string; kind: string; trigger_name: string }>();
		expect(running).toEqual({ system_id: "primer", kind: "seed", trigger_name: "deploy-drift" });
	});

	it("starts one deploy-drift system when every seed is stale", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const pageQueue = memoryD1();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: pageQueue,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const decision = await decideReindex(env, DRIFT_CRON);
		expect(decision).toEqual({
			action: "start",
			trigger: "deploy-drift",
			systems: ["paste"],
			catalogHash: SEED_HASH,
		});
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
		const running = await pageQueue
			.prepare("SELECT system_id FROM discover_run")
			.first<{ system_id: string }>();
		expect(running).toEqual({ system_id: "paste" });
	});

	it("recovers only parked seeds", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const pageQueue = memoryD1();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			PAGE_QUEUE: pageQueue,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await writePark(env, "garden", 1);
		const decision = await decideReindex(env, RECOVERY_CRON);
		expect(decision).toEqual({
			action: "start",
			trigger: "recovery",
			systems: ["garden"],
			catalogHash: SEED_HASH,
		});
		await handleScheduled({ cron: RECOVERY_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
		const running = await pageQueue
			.prepare("SELECT system_id, trigger_name FROM discover_run")
			.first<{ system_id: string; trigger_name: string }>();
		expect(running).toEqual({ system_id: "garden", trigger_name: "recovery" });
	});

	it("skips recovery when nothing is parked", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		expect(await decideReindex(env, RECOVERY_CRON)).toEqual({ action: "skip", reason: "no-systems" });
		await handleScheduled({ cron: RECOVERY_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
	});

	it("skips recovery while another workflow is running", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-running", existingStatus: "running" });
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await writePark(env, "garden", 1);
		await startStatusRun(env, { trigger: "recrawl", workflowId: "reindex-running" });
		expect(await decideReindex(env, RECOVERY_CRON)).toEqual({ action: "skip", reason: "running" });
		await handleScheduled({ cron: RECOVERY_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
	});

	it("recrawls every non-parked seed", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: mockWorkflow().binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await writePark(env, "garden", 1);
		const decision = await decideReindex(env, RECRAWL_CRON);
		expect(decision.action).toBe("start");
		if (decision.action === "start") {
			expect(decision.trigger).toBe("recrawl");
			expect(decision.systems).toEqual(SYSTEM_IDS.filter((id) => id !== "garden"));
		}
	});

	it("does not create a second workflow while one is running", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-running", existingStatus: "running" });
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-running" });
		expect(await decideReindex(env, DRIFT_CRON)).toEqual({ action: "skip", reason: "running" });
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toEqual([]);
	});

	it("does not create a workflow when startStatusRun leaves the running claim in place", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-running", existingStatus: "running" });
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-running" });
		expect(
			await startReindex(env, {
				action: "start",
				trigger: "recovery",
				systems: ["garden"],
				catalogHash: SEED_HASH,
			}),
		).toEqual({ skipped: "running" });
		expect(workflow.created).toEqual([]);
	});

	it("skips every cron start when parks KV is unread", async () => {
		const kv = parksKvGetThrows(memoryKV());
		const workflow = mockWorkflow();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const cron of [DRIFT_CRON, RECRAWL_CRON, RECOVERY_CRON]) {
			expect(await decideReindex(env, cron)).toEqual({ action: "skip", reason: "unread-parks" });
			await handleScheduled({ cron } as ScheduledController, env);
		}
		expect(workflow.created).toEqual([]);
	});

	it("starts after the stored running workflow has errored", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow({ existingId: "reindex-dead", existingStatus: "errored" });
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			REINDEX: workflow.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await startStatusRun(env, { trigger: "deploy-drift", workflowId: "reindex-dead" });
		expect(await decideReindex(env, DRIFT_CRON)).toMatchObject({ action: "start", trigger: "deploy-drift" });
	});
});
