import { describe, expect, it } from "vitest";
import type { SystemId } from "../src/config/types.ts";
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

	it("keeps the directory slash on a base href", async () => {
		const page = "https://ix.siemens.io/docs/home/overview";
		const urls = await frontierUrls("siemens-ix", page, [
			{
				url: page,
				markdown: '<base href="/docs/">\nSee [button](components/button).',
			},
		]);
		expect(urls).toEqual(["https://ix.siemens.io/docs/components/button"]);
	});

	it("ignores a base tag inside a code block", async () => {
		const fenced = ["```html", '<base href="/example/">', "```", "See [button](components/button)."].join("\n");
		const inline = "The tag `<base href=\"/example/\">` is sample markup. See [grid](components/grid).";
		const urls = await frontierUrls("vanilla", DOCS, [
			{ url: DOCS, markdown: fenced },
			{ url: PATTERN_PAGE, markdown: inline },
		]);
		expect(urls).toEqual([BUTTON, "https://vanillaframework.io/docs/patterns/components/grid"]);
	});

	it("ignores a cross-origin or out-of-scope base", async () => {
		const vanilla = await frontierUrls("vanilla", DOCS, [
			{
				url: DOCS,
				markdown: '<base href="https://primer.style/">\nSee [button](components/button).',
			},
		]);
		const backpack = await frontierUrls("backpack", "https://www.skyscanner.design/latest/real", [
			{
				url: "https://www.skyscanner.design/latest/real",
				markdown: '<base href="https://www.skyscanner.design/account/">\nSee [next](other).',
			},
		]);
		expect(vanilla).toEqual([BUTTON]);
		expect(backpack).toEqual(["https://www.skyscanner.design/latest/other"]);
	});
});

async function frontierUrls(
	systemId: SystemId,
	startUrl: string,
	records: Array<{ url: string; markdown: string }>,
): Promise<string[]> {
	const db = memoryD1();
	const pageQueue = new D1PageQueue(db);
	await pageQueue.ensure();
	await pageQueue.insertRun({
		systemId,
		kind: "seed",
		trigger: "deploy-drift",
		jobId: `job-${systemId}`,
		startUrl,
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
	await discoverTick(env, DRIFT_CRON, new Date(NOW), {
		poll: async () => ({ status: "completed", finished: records.length, total: records.length }),
		page: async () => ({
			records: records.map((record) => ({ ...record, status: "completed" })),
			cursor: null,
		}),
		start: async (_auth, _seed, next) => ({ startUrl: next ?? "", jobId: "job-next" }),
		cancel: async () => undefined,
	});
	const frontier = await db
		.prepare("SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url")
		.bind(systemId)
		.all<{ url: string }>();
	return frontier.results?.map((row) => row.url) ?? [];
}
