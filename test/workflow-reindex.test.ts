import { describe, expect, it, vi } from "vitest";
import { CLI_POLL_INTERVAL_MS } from "../src/crawl/browser-run.ts";
import { seedById } from "../src/config/seed.ts";
import { shouldWriteSeedHash } from "../src/index/trigger.ts";
import { swapFromOutcome } from "../src/index/reindex.ts";
import { WORKFLOW_POLL_SLEEP, waitForCrawlJob, type WorkflowSleepStep } from "../src/index/workflow-poll.ts";

const uploadItem = vi.hoisted(() => vi.fn());
const deleteItem = vi.hoisted(() => vi.fn());
const listItems = vi.hoisted(() => vi.fn());

vi.mock("../src/index/items-rest.ts", () => ({
	uploadItem,
	deleteItem,
	listItems,
	ensureInstance: vi.fn(),
}));

describe("workflow crawl poll", () => {
	it("sleeps two minutes between Browser Run polls and keeps the CLI at 15s", async () => {
		expect(WORKFLOW_POLL_SLEEP).toBe("2 minutes");
		expect(CLI_POLL_INTERVAL_MS).toBe(15_000);
		const sleeps: Array<string | number> = [];
		let polls = 0;
		const step: WorkflowSleepStep = {
			do: async (_name, callback) => {
				polls += 1;
				return callback();
			},
			sleep: async (_name, duration) => {
				sleeps.push(duration);
			},
		};
		const pollJob = vi.spyOn(await import("../src/crawl/browser-run.ts"), "pollJob");
		pollJob
			.mockResolvedValueOnce({ status: "running", total: 1, finished: 0 })
			.mockResolvedValueOnce({ status: "completed", total: 2, finished: 2 });
		const snapshot = await waitForCrawlJob(
			step,
			{ accountId: "acct", apiToken: "token" },
			"job-1",
			"primer",
		);
		expect(snapshot).toEqual({ status: "completed", total: 2, finished: 2 });
		expect(sleeps).toEqual(["2 minutes"]);
		expect(polls).toBe(2);
		pollJob.mockRestore();
	});
});

describe("swapFromOutcome", () => {
	it("parks a completed 0-page or 1-page usable set and does not upload", async () => {
		const auth = { accountId: "acct", apiToken: "token" };
		const seed = seedById("primer");
		const none = await swapFromOutcome(auth, seed, {
			startUrl: seed.startUrl,
			status: "completed",
			counts: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
			records: [],
		});
		expect(none).toMatchObject({
			parked: true,
			keptPrevious: true,
			indexed: 0,
			usable: 0,
			error: "stub: only 0 usable page(s)",
		});
		const stub = await swapFromOutcome(auth, seed, {
			startUrl: seed.startUrl,
			status: "completed",
			counts: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
			records: [{ url: "https://primer.style/", status: "completed", markdown: "# one" }],
		});
		expect(stub).toMatchObject({
			parked: true,
			keptPrevious: true,
			indexed: 0,
			usable: 1,
			error: "stub: only 1 usable page(s)",
		});
		expect(uploadItem).not.toHaveBeenCalled();
		expect(shouldWriteSeedHash(stub)).toBe(true);
		expect(shouldWriteSeedHash({ ...stub, parked: false, error: "crawl ended failed" })).toBe(false);
	});

	it("swaps two usable pages and does not park", async () => {
		uploadItem.mockResolvedValue({ id: "1", key: "k" });
		listItems.mockResolvedValue([]);
		const seed = seedById("primer");
		const result = await swapFromOutcome({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			status: "completed",
			counts: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			records: [
				{ url: "https://primer.style/", status: "completed", markdown: "# one" },
				{ url: "https://primer.style/select", status: "completed", markdown: "# two" },
			],
		});
		expect(result.parked).toBeUndefined();
		expect(result.indexed).toBe(2);
		expect(result.keptPrevious).toBe(false);
		expect(uploadItem).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result)).not.toMatch(/records|markdown/);
		expect(shouldWriteSeedHash(result)).toBe(true);
	});
});
