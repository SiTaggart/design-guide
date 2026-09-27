import { describe, expect, it, vi } from "vitest";
import { CLI_POLL_INTERVAL_MS } from "../src/crawl/browser-run.ts";
import { seedById } from "../src/config/seed.ts";
import { shouldWriteSeedHash } from "../src/index/trigger.ts";
import { streamSwap, swapFromOutcome, swapGeneration } from "../src/index/reindex.ts";
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

	it("leaves the prior generation in place on fail, hitLimit, and a one-page stub", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const prior = { id: "old-1", key: "primer/oldgen/aaaa.md" };
		const items = [prior];
		listItems.mockImplementation(async () => [...items]);
		deleteItem.mockImplementation(async (_auth: unknown, id: string) => {
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
		});
		const seed = seedById("primer");
		const auth = { accountId: "acct", apiToken: "token" };
		const counts = { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 };
		const pages = [
			{ url: "https://primer.style/", status: "completed", markdown: "# one" },
			{ url: "https://primer.style/select", status: "completed", markdown: "# two" },
		];
		const failed = await swapFromOutcome(auth, seed, {
			startUrl: seed.startUrl,
			status: "failed",
			counts: { ...counts, total: 0, finished: 0 },
			records: pages,
		});
		const limited = await swapFromOutcome(auth, seed, {
			startUrl: seed.startUrl,
			status: "cancelled_due_to_limits",
			counts,
			records: pages,
		});
		const stub = await swapFromOutcome(auth, seed, {
			startUrl: seed.startUrl,
			status: "completed",
			counts: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
			records: [pages[0]!],
		});
		expect(failed).toMatchObject({ indexed: 0, keptPrevious: true, error: "crawl ended failed" });
		expect(failed.parked).toBeUndefined();
		expect(limited).toMatchObject({ indexed: 0, keptPrevious: true, hitLimit: true });
		expect(stub).toMatchObject({ indexed: 0, keptPrevious: true, parked: true, usable: 1 });
		expect(items).toEqual([prior]);
		expect(uploadItem).not.toHaveBeenCalled();
	});

	it("keeps the uploaded generation when a later attempt fails after the prior generation is gone", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
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
		deleteItem.mockImplementation(async (_auth: unknown, id: string) => {
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
		});
		const seed = seedById("primer");
		const generation = swapGeneration("primer", "reindex-wf-committed");
		const outcome = {
			startUrl: seed.startUrl,
			status: "completed" as const,
			counts: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			records: [
				{ url: "https://primer.style/", status: "completed" as const, markdown: "# one" },
				{ url: "https://primer.style/select", status: "completed" as const, markdown: "# two" },
			],
		};
		const swapped = await swapFromOutcome({ accountId: "acct", apiToken: "token" }, seed, outcome, {
			generation,
		});
		expect(swapped).toMatchObject({ indexed: 2, keptPrevious: false });
		expect(items.map((item) => item.key).every((key) => key.startsWith(`primer/${generation}/`))).toBe(true);
		uploadItem.mockRejectedValue(new Error("item upload failed primer/x.md: [{\"code\":7009}]"));
		const retried = await swapFromOutcome({ accountId: "acct", apiToken: "token" }, seed, outcome, {
			generation,
		});
		expect(retried.keptPrevious).toBe(false);
		expect(retried.indexed).toBe(2);
		expect(retried.error).toContain("7009");
		expect(items).toHaveLength(2);
		expect(items.every((item) => item.key.startsWith(`primer/${generation}/`))).toBe(true);
	});

	it("deletes only the partial new generation when upload fails and the prior generation remains", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const items: Array<{ id: string; key: string }> = [{ id: "old-1", key: "primer/oldgen/aaaa.md" }];
		listItems.mockImplementation(async () => [...items]);
		uploadItem.mockImplementation(async (_auth: unknown, key: string) => {
			if (items.some((item) => item.key.startsWith("primer/") && item.id !== "old-1")) {
				throw new Error("item upload failed primer/x.md: [{\"code\":7114}]");
			}
			const created = { id: "new-1", key };
			items.push(created);
			return created;
		});
		deleteItem.mockImplementation(async (_auth: unknown, id: string) => {
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
		});
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
		expect(result).toMatchObject({ indexed: 0, keptPrevious: true });
		expect(result.error).toContain("7114");
		expect(items).toEqual([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
	});
});

describe("streamSwap", () => {
	const counts = { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 };

	function itemStore(initial: Array<{ id: string; key: string }> = []) {
		const items = [...initial];
		listItems.mockImplementation(async () => [...items]);
		deleteItem.mockImplementation(async (_auth: unknown, id: string) => {
			const index = items.findIndex((item) => item.id === id);
			if (index >= 0) {
				items.splice(index, 1);
			}
		});
		uploadItem.mockImplementation(async (_auth: unknown, key: string) => {
			const existing = items.find((item) => item.key === key);
			if (existing) {
				return existing;
			}
			const created = { id: `id-${items.length}`, key };
			items.push(created);
			return created;
		});
		return items;
	}

	function runStep(): {
		step: <T>(name: string, run: () => Promise<T>) => Promise<T>;
		returned: unknown[];
	} {
		const returned: unknown[] = [];
		return {
			returned,
			step: async (_name, run) => {
				const value = await run();
				returned.push(value);
				return value;
			},
		};
	}

	it("uploads one crawl page at a time and deletes the prior generation only after the last page", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const items = itemStore([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
		const seed = seedById("primer");
		const generation = swapGeneration("primer", "reindex-stream");
		const pages = [
			{
				records: [{ url: "https://primer.style/a", status: "completed", markdown: "# one" }],
				cursor: "2" as string | null,
			},
			{
				records: [{ url: "https://primer.style/b", status: "completed", markdown: "# two" }],
				cursor: null,
			},
		];
		let fetched = 0;
		let overloads = 0;
		uploadItem.mockImplementation(async (_auth: unknown, key: string, _body: unknown, _meta: unknown, options?: { onOverload?: () => void }) => {
			options?.onOverload?.();
			const existing = items.find((item) => item.key === key);
			if (existing) {
				return existing;
			}
			const created = { id: `id-${items.length}`, key };
			items.push(created);
			return created;
		});
		const { step, returned } = runStep();
		const result = await streamSwap({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			snapshot: { status: "completed", total: 2, finished: 2 },
			generation,
			fetchPage: async () => {
				const page = pages[fetched];
				fetched += 1;
				if (!page) {
					throw new Error("fetched past the last page");
				}
				return page;
			},
			countStatuses: async () => counts,
			step,
			onOverload: () => {
				overloads += 1;
			},
		});
		expect(result).toMatchObject({ indexed: 2, keptPrevious: false, deleted: 1, usable: 2 });
		expect(overloads).toBe(2);
		expect(fetched).toBe(2);
		expect(uploadItem).toHaveBeenCalledTimes(2);
		expect(items.map((item) => item.id)).toEqual(["id-1", "id-2"]);
		expect(items.every((item) => item.key.startsWith(`primer/${generation}/`))).toBe(true);
		expect(JSON.stringify(returned)).not.toContain("# one");
		expect(JSON.stringify(returned)).not.toContain("# two");
	});

	it("keeps the prior generation when a later page fails to upload", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const items = itemStore([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
		const seed = seedById("primer");
		let fetched = 0;
		uploadItem.mockImplementation(async (_auth: unknown, key: string) => {
			if (String(key).includes("select") || items.some((item) => item.id !== "old-1")) {
				throw new Error("item upload failed primer/x.md: [{\"code\":7009}]");
			}
			const created = { id: "new-1", key: String(key) };
			items.push(created);
			return created;
		});
		const result = await streamSwap({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			snapshot: { status: "completed", total: 2, finished: 2 },
			generation: swapGeneration("primer", "reindex-stream-fail"),
			fetchPage: async () => {
				fetched += 1;
				if (fetched === 1) {
					return {
						records: [{ url: "https://primer.style/", status: "completed", markdown: "# one" }],
						cursor: "2",
					};
				}
				return {
					records: [{ url: "https://primer.style/select", status: "completed", markdown: "# two" }],
					cursor: null,
				};
			},
			countStatuses: async () => counts,
		});
		expect(result).toMatchObject({ indexed: 0, keptPrevious: true, usable: 1 });
		expect(result.error).toContain("7009");
		expect(items).toEqual([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
	});

	it("does not fetch pages when the crawl failed or hit the page cap", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const items = itemStore([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
		const seed = seedById("primer");
		const fetchPage = async () => {
			throw new Error("pages should stay on the crawl service");
		};
		const failed = await streamSwap({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			snapshot: { status: "failed", total: 0, finished: 0 },
			generation: "gen-fail",
			fetchPage,
			countStatuses: async () => ({ ...counts, total: 0, finished: 0 }),
		});
		const limited = await streamSwap({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			snapshot: { status: "completed", total: 500, finished: 500 },
			generation: "gen-limit",
			fetchPage,
			countStatuses: async () => ({ ...counts, total: 500, finished: 500 }),
		});
		expect(failed).toMatchObject({ indexed: 0, keptPrevious: true, error: "crawl ended failed" });
		expect(limited).toMatchObject({ indexed: 0, keptPrevious: true, hitLimit: true });
		expect(items).toEqual([{ id: "old-1", key: "primer/oldgen/aaaa.md" }]);
		expect(uploadItem).not.toHaveBeenCalled();
	});

	it("parks a one-page upload and leaves the prior generation", async () => {
		uploadItem.mockReset();
		deleteItem.mockReset();
		listItems.mockReset();
		const items = itemStore([{ id: "old-1", key: "garden/oldgen/aaaa.md" }]);
		const seed = seedById("garden");
		const result = await streamSwap({ accountId: "acct", apiToken: "token" }, seed, {
			startUrl: seed.startUrl,
			snapshot: { status: "completed", total: 1, finished: 1 },
			generation: swapGeneration("garden", "reindex-stub"),
			fetchPage: async () => ({
				records: [{ url: "https://garden.zendesk.com/", status: "completed", markdown: "# one" }],
				cursor: null,
			}),
			countStatuses: async () => ({ total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 }),
		});
		expect(result).toMatchObject({
			indexed: 0,
			keptPrevious: true,
			parked: true,
			usable: 1,
			error: "stub: only 1 usable page(s)",
		});
		expect(items).toEqual([{ id: "old-1", key: "garden/oldgen/aaaa.md" }]);
	});
});
