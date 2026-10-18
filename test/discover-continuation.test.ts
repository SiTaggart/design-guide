import { describe, expect, it } from "vitest";
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
});
