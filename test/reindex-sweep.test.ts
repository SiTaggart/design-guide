import { beforeEach, describe, expect, it, vi } from "vitest";

const listItems = vi.hoisted(() => vi.fn());
const deleteItem = vi.hoisted(() => vi.fn());
const ensureInstance = vi.hoisted(() => vi.fn());
const uploadItem = vi.hoisted(() => vi.fn());
const crawlSeed = vi.hoisted(() => vi.fn());

vi.mock("../src/index/items-rest.ts", () => ({
	listItems,
	deleteItem,
	ensureInstance,
	uploadItem,
}));

vi.mock("../src/crawl/browser-run.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/crawl/browser-run.ts")>();
	return {
		...actual,
		crawlSeed,
	};
});

import { reindex } from "../src/index/reindex.ts";

const PARKED = [
	{ id: "rs-1", key: "react-spectrum/20260908t061435z/8506864cbf332c6e.md" },
	{ id: "c-1", key: "carbon/gen/deadbeef.md" },
];

beforeEach(() => {
	listItems.mockReset();
	deleteItem.mockReset();
	ensureInstance.mockReset();
	uploadItem.mockReset();
	crawlSeed.mockReset();
	ensureInstance.mockResolvedValue(undefined);
	deleteItem.mockResolvedValue(undefined);
	listItems.mockResolvedValue([
		...PARKED,
		{ id: "p-1", key: "paste/20260908t125426z/aaaa.md" },
	]);
	crawlSeed.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
		startUrl: seed.startUrl,
		status: "failed",
		counts: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
		records: [],
	}));
});

describe("reindex dropped-system sweep", () => {
	it("deletes AI Search keys whose prefix is not in SYSTEM_IDS", async () => {
		await reindex({ accountId: "acct", apiToken: "token" });
		expect(deleteItem.mock.calls.map((call) => call[1])).toEqual(["rs-1", "c-1"]);
		expect(uploadItem).not.toHaveBeenCalled();
	});
});
