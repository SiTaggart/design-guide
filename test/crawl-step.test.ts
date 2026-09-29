import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlStatusCounts, fetchCrawlPage, type CrawlJobResult } from "../src/crawl/browser-run.ts";

const auth = { accountId: "acct", apiToken: "token" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("crawl step bounds", () => {
	it("reads skipped, disallowed, and errored from the job instead of paging records", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				calls.push(url);
				return Response.json({
					success: true,
					result: {
						records: [{ url: "https://primer.style/skipped", status: "skipped", markdown: "x".repeat(2_000_000) }],
						cursor: "more",
					},
				});
			}),
		);
		const counts = await crawlStatusCounts(auth, "job-1", {
			total: 40,
			finished: 10,
			skipped: 20,
			disallowed: 3,
			errored: 7,
		} as CrawlJobResult);
		expect(calls).toEqual([]);
		expect(counts).toEqual({ total: 40, finished: 10, skipped: 20, disallowed: 3, errored: 7 });
	});

	it("asks for one completed record per page fetch", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				calls.push(url);
				return Response.json({
					success: true,
					result: {
						records: [{ url: "https://primer.style/getting-started", status: "completed", markdown: "# Primer" }],
						cursor: null,
					},
				});
			}),
		);
		const page = await fetchCrawlPage(auth, "job-1", "completed");
		expect(page).toEqual({
			records: [{ url: "https://primer.style/getting-started", status: "completed", markdown: "# Primer" }],
			cursor: null,
		});
		const query = new URL(calls[0] ?? "");
		expect(query.searchParams.get("status")).toBe("completed");
		expect(query.searchParams.get("limit")).toBe("1");
	});
});
