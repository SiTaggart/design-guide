import { describe, expect, it, vi } from "vitest";
import { ReindexWorkflow } from "../src/workflows/reindex.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const streamSwap = vi.hoisted(() => vi.fn());
const startSeedCrawl = vi.hoisted(() => vi.fn());
const pollJob = vi.hoisted(() => vi.fn());

vi.mock("../src/index/reindex.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/index/reindex.ts")>();
	return { ...actual, streamSwap };
});

vi.mock("../src/crawl/browser-run.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/crawl/browser-run.ts")>();
	return { ...actual, startSeedCrawl, pollJob };
});

vi.mock("../src/index/items-rest.ts", () => ({
	ensureInstance: vi.fn(async () => undefined),
	listItems: vi.fn(async () => []),
	deleteItem: vi.fn(async () => undefined),
	uploadItem: vi.fn(async () => ({ id: "1", key: "k" })),
}));

function stepRecorder() {
	const sleeps: Array<string | number> = [];
	return {
		sleeps,
		step: {
			do: async (_name: string, ...args: unknown[]) => {
				const callback = args[args.length - 1] as () => Promise<unknown>;
				return callback();
			},
			sleep: async (_name: string, duration: string | number) => {
				sleeps.push(duration);
			},
		},
	};
}

describe("reindex workflow overload gap", () => {
	it("sleeps 30 seconds between systems after an AI Search overload and not after the last system", async () => {
		startSeedCrawl.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
			startUrl: seed.startUrl,
			jobId: "job-1",
		}));
		pollJob.mockResolvedValue({ status: "completed", total: 2, finished: 2 });
		streamSwap.mockImplementation(async (_auth: unknown, seed: { id: string; startUrl: string }, input: { onOverload?: () => void }) => {
			input.onOverload?.();
			return {
				system: seed.id,
				startUrl: seed.startUrl,
				crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
				indexed: 2,
				hitLimit: false,
				keptPrevious: false,
				usable: 2,
			};
		});
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { sleeps, step } = stepRecorder();
		await workflow.run(
			{
				payload: {
					trigger: "deploy-drift",
					systems: ["paste", "primer"],
					catalogHash: "hash",
					workflowId: "reindex-drift-pace",
				},
				timestamp: new Date("2026-09-27T00:00:00.000Z"),
				instanceId: "reindex-drift-pace",
				workflowName: "reindex",
			},
			step as never,
		);
		expect(sleeps).toEqual(["30 seconds"]);
		expect(streamSwap).toHaveBeenCalledTimes(2);
	});
});
