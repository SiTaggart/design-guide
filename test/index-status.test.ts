import { describe, expect, it } from "vitest";
import { SEED_HASH } from "../src/index/seed-hash.ts";
import { writePark } from "../src/index/parks.ts";
import { startStatusRun, writeStatus } from "../src/index/status.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

describe("GET /v1/index-status", () => {
	it("returns unbound 200 when INDEX is missing", async () => {
		const { env } = envWithIndex(fixtureChunks);
		const response = await worker.fetch(new Request("https://example.test/v1/index-status"), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			unbound: true,
			workflowId: null,
			seedHash: SEED_HASH,
			lastIndexedHash: null,
			parks: {},
			systems: [],
			errors: { crawl: [], render: [], index: [] },
			counts: { systems: 0, indexed: 0, parked: 0, errors: 0 },
		});
	});

	it("returns last-run JSON with parks, errors, and workflow id", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		await startStatusRun(env, { trigger: "drift", workflowId: "reindex-drift-test" });
		await writeStatus(env, {
			unbound: false,
			workflowId: "reindex-drift-test",
			trigger: "drift",
			state: "fail",
			startedAt: "2026-09-27T00:00:00.000Z",
			finishedAt: "2026-09-27T00:10:00.000Z",
			seedHash: SEED_HASH,
			lastIndexedHash: null,
			parks: {},
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
		});
		const response = await worker.fetch(new Request("https://example.test/v1/index-status"), env);
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
});
