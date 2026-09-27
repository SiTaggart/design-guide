import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { seedById } from "../src/config/seed.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { writePark } from "../src/index/parks.ts";
import { SEED_HASH, systemSeedHash } from "../src/index/seed-hash.ts";
import { startStatusRun } from "../src/index/status.ts";
import { DRIFT_CRON, RECRAWL_CRON, RECOVERY_CRON, decideReindex } from "../src/index/trigger.ts";
import { handleScheduled } from "../src/schedule.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV, mockWorkflow } from "./helpers/index-env.ts";

describe("wrangler automation config", () => {
	const wrangler = readFileSync("wrangler.jsonc", "utf8");

	it("uses Worker crons and a 25000-step Workflow, not Workflow schedules", () => {
		expect(wrangler).toContain('"*/5 * * * *"');
		expect(wrangler).toContain('"0 4 * * *"');
		expect(wrangler).toContain('"0 6 * * 0"');
		expect(wrangler).toContain('"steps": 25000');
		expect(wrangler).not.toContain('"schedules"');
		expect(DRIFT_CRON).toBe("*/5 * * * *");
		expect(RECRAWL_CRON).toBe("0 4 * * *");
		expect(RECOVERY_CRON).toBe("0 6 * * 0");
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

	it("starts a drift workflow for the one changed seed, including a parked seed", async () => {
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
		const decision = await decideReindex(env, DRIFT_CRON);
		expect(decision).toMatchObject({ action: "start", trigger: "deploy-drift", systems: ["garden"] });
		await handleScheduled({ cron: DRIFT_CRON } as ScheduledController, env);
		expect(workflow.created).toHaveLength(1);
		expect(workflow.created[0]?.params?.systems).toEqual(["garden"]);
		expect(workflow.created[0]?.params?.trigger).toBe("deploy-drift");
	});

	it("recovers only parked seeds", async () => {
		const kv = memoryKV();
		const workflow = mockWorkflow();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
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
		expect(workflow.created).toHaveLength(1);
		expect(workflow.created[0]?.params?.trigger).toBe("recovery");
		expect(workflow.created[0]?.params?.systems).toEqual(["garden"]);
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
