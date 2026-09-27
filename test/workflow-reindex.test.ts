import { describe, expect, it, vi } from "vitest";
import { CLI_POLL_INTERVAL_MS } from "../src/crawl/browser-run.ts";
import { seedById } from "../src/config/seed.ts";
import { shouldWriteSeedHash } from "../src/index/trigger.ts";
import { swapFromOutcome, swapGeneration } from "../src/index/reindex.ts";
import {
	WORKFLOW_POLL_MAX,
	WORKFLOW_POLL_SLEEP,
	waitForCrawlJob,
	type WorkflowSleepStep,
} from "../src/index/workflow-poll.ts";
import { CRAWL_POLL_DEADLINE_MS } from "../src/crawl/browser-run.ts";

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

	it("fails a crawl that is still running at the poll deadline", async () => {
		expect(WORKFLOW_POLL_MAX).toBe(Math.ceil(CRAWL_POLL_DEADLINE_MS / (2 * 60 * 1000)));
		const sleeps: Array<string | number> = [];
		const step: WorkflowSleepStep = {
			do: async (_name, callback) => callback(),
			sleep: async (_name, duration) => {
				sleeps.push(duration);
			},
		};
		const pollJob = vi.spyOn(await import("../src/crawl/browser-run.ts"), "pollJob");
		pollJob.mockResolvedValue({ status: "running", total: 1, finished: 0 });
		await expect(
			waitForCrawlJob(step, { accountId: "acct", apiToken: "token" }, "job-late", "primer", {
				maxPolls: 2,
			}),
		).rejects.toThrow("crawl job-late still running at the poll deadline");
		expect(sleeps).toEqual(["2 minutes"]);
		expect(pollJob).toHaveBeenCalledTimes(2);
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

	it("resumes the same generation after a mid-delete failure", async () => {
		const items: Array<{ id: string; key: string }> = [{ id: "old-1", key: "primer/oldgen/aaaa.md" }];
		listItems.mockImplementation(async () => [...items]);
		uploadItem.mockImplementation(async (_auth: unknown, key: string) => {
			const existing = items.find((item) => item.key === key);
			if (existing) {
				return existing;
			}
			const created = { id: `new-${items.length}`, key };
			items.push(created);
			return created;
		});
		let deletes = 0;
		deleteItem.mockImplementation(async (_auth: unknown, id: string) => {
			deletes += 1;
			if (deletes === 1) {
				throw new Error("item delete failed old-1: boom");
			}
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
		});
		const seed = seedById("primer");
		const generation = swapGeneration("primer", "reindex-wf-retry");
		const outcome = {
			startUrl: seed.startUrl,
			status: "completed" as const,
			counts: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			records: [
				{ url: "https://primer.style/", status: "completed" as const, markdown: "# one" },
				{ url: "https://primer.style/select", status: "completed" as const, markdown: "# two" },
			],
		};
		await expect(
			swapFromOutcome({ accountId: "acct", apiToken: "token" }, seed, outcome, { generation }),
		).rejects.toThrow("item delete failed old-1: boom");
		expect(items.some((item) => item.key === "primer/oldgen/aaaa.md")).toBe(true);
		expect(items.filter((item) => item.key.startsWith(`primer/${generation}/`))).toHaveLength(2);
		const retried = await swapFromOutcome(
			{ accountId: "acct", apiToken: "token" },
			seed,
			outcome,
			{ generation },
		);
		expect(retried).toMatchObject({ indexed: 2, keptPrevious: false });
		expect(items).toHaveLength(2);
		expect(items.every((item) => item.key.startsWith(`primer/${generation}/`))).toBe(true);
		expect(uploadItem.mock.calls.map((call) => call[1])).toEqual([
			expect.stringMatching(new RegExp(`^primer/${generation}/`)),
			expect.stringMatching(new RegExp(`^primer/${generation}/`)),
			expect.stringMatching(new RegExp(`^primer/${generation}/`)),
			expect.stringMatching(new RegExp(`^primer/${generation}/`)),
		]);
	});
});
