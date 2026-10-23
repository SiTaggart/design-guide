import { describe, expect, it } from "vitest";
import { discoverTick } from "../src/index/discover.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const DRIFT_CRON = "*/5 * * * *";
const DOCS = "https://vanillaframework.io/docs/";
const BUTTON = "https://vanillaframework.io/docs/components/button";
const PATTERN_PAGE = "https://vanillaframework.io/docs/patterns/form";
const GRID = "https://vanillaframework.io/docs/components/grid";

describe("relative links use the fetched page", () => {
	it("resolves a relative link against the page url and a base href", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.insertRun({
			systemId: "vanilla",
			kind: "seed",
			trigger: "deploy-drift",
			jobId: "job-vanilla",
			startUrl: DOCS,
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
			poll: async () => ({ status: "completed", finished: 2, total: 2 }),
			page: async () => ({
				records: [
					{
						url: DOCS,
						status: "completed",
						markdown: "See [button](components/button).",
					},
					{
						url: PATTERN_PAGE,
						status: "completed",
						markdown: '<base href="/docs/">\nSee [grid](components/grid).',
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
		const frontier = await db
			.prepare("SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url")
			.bind("vanilla")
			.all<{ url: string }>();
		expect(result).toMatchObject({ action: "continued", systemId: "vanilla" });
		expect(frontier.results?.map((row) => row.url)).toEqual([BUTTON, GRID]);
		expect(started).toEqual([BUTTON]);
	});
});
