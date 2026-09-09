import { afterEach, describe, expect, it, vi } from "vitest";
import type { Seed } from "../src/config/types.ts";
import { crawlSeed, hitCrawlLimit, type CrawlRecord } from "../src/crawl/browser-run.ts";

type JobPage = { records: CrawlRecord[]; cursor?: string | number };

type FakeCrawl = {
	startStatus: Record<string, number>;
	jobStatus: string;
	total: number;
	finished: number;
	pages: Record<string, JobPage[]>;
};

const auth = { accountId: "acct", apiToken: "token" };

const seed: Seed = {
	id: "gitlab-pajamas",
	source: "Pajamas",
	startUrl: "https://design.gitlab.com/",
	fallbackStartUrl: "https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com",
	excludePatterns: ["**/*spectrum.adobe.com*"],
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFakeCrawl(fake: FakeCrawl): { startedUrls: string[]; requests: string[] } {
	const startedUrls: string[] = [];
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
			if (init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { url: string };
				startedUrls.push(body.url);
				const status = fake.startStatus[body.url] ?? 200;
				return status === 200 ? json({ success: true, result: "job-1" }) : json({ success: false, errors: [{ code: status }] }, status);
			}
			const recordStatus = url.searchParams.get("status");
			if (recordStatus === null) {
				return json({ success: true, result: { id: "job-1", status: fake.jobStatus, total: fake.total, finished: fake.finished, records: [] } });
			}
			const pages = fake.pages[recordStatus] ?? [{ records: [] }];
			const cursor = url.searchParams.get("cursor");
			const page = cursor === null ? pages[0] : pages.find((_, index) => String(index) === cursor) ?? { records: [] };
			return json({ success: true, result: { id: "job-1", status: fake.jobStatus, total: fake.total, finished: fake.finished, ...page } });
		}),
	);
	return { startedUrls, requests };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("crawlSeed", () => {
	it("collects counts and https markdown records from a completed job", async () => {
		const { startedUrls, requests } = installFakeCrawl({
			startStatus: {},
			jobStatus: "completed",
			total: 7,
			finished: 7,
			pages: {
				completed: [
					{
						records: [
							{ url: "https://design.gitlab.com/", status: "completed", markdown: "# Pajamas" },
							{ url: "http://design.gitlab.com/insecure", status: "completed", markdown: "nope" },
							{ url: "https://design.gitlab.com/blank", status: "completed", markdown: "   " },
						],
						cursor: 1,
					},
					{ records: [{ url: "https://design.gitlab.com/components/", status: "completed", markdown: "## Components" }] },
				],
				skipped: [{ records: [{ url: "https://spectrum.adobe.com/", status: "skipped" }], cursor: 1 }, { records: [{ url: "https://x.test/", status: "skipped" }] }],
				disallowed: [{ records: [{ url: "https://design.gitlab.com/private", status: "disallowed" }] }],
			},
		});
		const outcome = await crawlSeed(auth, seed);
		expect(startedUrls).toEqual(["https://design.gitlab.com/"]);
		expect(outcome.startUrl).toBe("https://design.gitlab.com/");
		expect(outcome.status).toBe("completed");
		expect(outcome.counts).toEqual({ total: 7, finished: 7, skipped: 2, disallowed: 1, errored: 0 });
		expect(outcome.records.map((record) => record.url)).toEqual([
			"https://design.gitlab.com/",
			"https://design.gitlab.com/components/",
		]);
		expect(requests.filter((request) => request.includes("status=completed"))).toHaveLength(2);
		expect(hitCrawlLimit(outcome, outcome.records.length)).toBe(false);
	});

	it("retries once with the fallback start url when the primary start is rejected", async () => {
		const { startedUrls } = installFakeCrawl({
			startStatus: { "https://design.gitlab.com/": 404 },
			jobStatus: "completed",
			total: 1,
			finished: 1,
			pages: { completed: [{ records: [{ url: "https://gitlab.com/readme", status: "completed", markdown: "readme" }] }] },
		});
		const outcome = await crawlSeed(auth, seed);
		expect(startedUrls).toEqual(["https://design.gitlab.com/", "https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com"]);
		expect(outcome.startUrl).toBe("https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com");
		expect(outcome.records).toHaveLength(1);
	});

	it("does not fall back when the primary crawl completes with no records", async () => {
		const { startedUrls } = installFakeCrawl({ startStatus: {}, jobStatus: "completed", total: 0, finished: 0, pages: {} });
		const outcome = await crawlSeed(auth, seed);
		expect(startedUrls).toEqual(["https://design.gitlab.com/"]);
		expect(outcome.records).toEqual([]);
		expect(outcome.counts).toEqual({ total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 });
	});

	it("throws with the failing url when the fallback start is rejected too", async () => {
		installFakeCrawl({
			startStatus: { "https://design.gitlab.com/": 500, "https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com": 400 },
			jobStatus: "completed",
			total: 0,
			finished: 0,
			pages: {},
		});
		await expect(crawlSeed(auth, seed)).rejects.toThrow(/gitlab\.com\/gitlab-org.*failed 400/);
	});

	it("returns counts instead of throwing when Cloudflare cancels the job for limits", async () => {
		installFakeCrawl({
			startStatus: {},
			jobStatus: "cancelled_due_to_limits",
			total: 5000,
			finished: 4200,
			pages: { errored: [{ records: [{ url: "https://design.gitlab.com/500", status: "errored" }] }] },
		});
		const outcome = await crawlSeed(auth, seed);
		expect(outcome.status).toBe("cancelled_due_to_limits");
		expect(outcome.counts).toEqual({ total: 5000, finished: 4200, skipped: 0, disallowed: 0, errored: 1 });
		expect(hitCrawlLimit(outcome, 0)).toBe(true);
	});
});
