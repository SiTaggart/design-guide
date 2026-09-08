import { describe, expect, it } from "vitest";
import { CRAWL_DEPTH, CRAWL_LIMIT } from "../src/config/instance.ts";
import { seedById } from "../src/config/seed.ts";
import type { Seed } from "../src/config/types.ts";
import { crawlRequestBody, hitCrawlLimit } from "../src/crawl/browser-run.ts";

describe("crawlRequestBody", () => {
	it("asks for one full-site crawl at the Cloudflare maximum", () => {
		const body = crawlRequestBody(seedById("primer"), "https://primer.style/");
		expect(CRAWL_LIMIT).toBe(100_000);
		expect(CRAWL_DEPTH).toBe(100_000);
		expect(body).toEqual({
			url: "https://primer.style/",
			source: "all",
			limit: 100_000,
			depth: 100_000,
			formats: ["markdown"],
			render: true,
			crawlPurposes: ["search"],
			contentUse: "reference",
			options: {
				includeExternalLinks: false,
				includeSubdomains: false,
				excludePatterns: seedById("primer").excludePatterns,
			},
		});
	});

	it("never sends rejectResourceTypes, even for the static GitHub crawls", () => {
		for (const seed of ["carbon", "react-spectrum", "primer", "uswds"] as const) {
			const json = JSON.stringify(crawlRequestBody(seedById(seed), seedById(seed).startUrl));
			expect(json).not.toContain("rejectResourceTypes");
		}
		expect(crawlRequestBody(seedById("carbon"), seedById("carbon").startUrl).render).toBe(false);
		expect(crawlRequestBody(seedById("react-spectrum"), seedById("react-spectrum").startUrl).render).toBe(true);
	});

	it("omits includePatterns when the seed has none or an empty list", () => {
		expect(crawlRequestBody(seedById("govuk"), "https://design-system.service.gov.uk/").options).not.toHaveProperty(
			"includePatterns",
		);
		const emptied: Seed = { ...seedById("govuk"), includePatterns: [] };
		expect(crawlRequestBody(emptied, emptied.startUrl).options).not.toHaveProperty("includePatterns");
	});

	it("keeps the host-scope includePatterns for uswds, carbon, and react-spectrum", () => {
		expect(crawlRequestBody(seedById("uswds"), seedById("uswds").startUrl).options.includePatterns).toEqual([
			"https://designsystem.digital.gov/**",
		]);
		expect(crawlRequestBody(seedById("carbon"), seedById("carbon").startUrl).options.includePatterns).toEqual([
			"https://github.com/carbon-design-system/carbon",
			"https://github.com/carbon-design-system/carbon/**",
		]);
		expect(crawlRequestBody(seedById("react-spectrum"), seedById("react-spectrum").startUrl).options.includePatterns).toEqual([
			"https://github.com/adobe/react-spectrum/blob/main/packages/dev/s2-docs/pages/**",
			"https://raw.githubusercontent.com/adobe/react-spectrum/main/packages/dev/s2-docs/pages/**",
		]);
		expect(crawlRequestBody(seedById("react-spectrum"), seedById("react-spectrum").startUrl).options.excludePatterns).toEqual(
			expect.arrayContaining(["**/tree/**"]),
		);
	});

	it("uses the start url it is handed so a fallback crawl reports the fallback", () => {
		const pajamas = seedById("gitlab-pajamas");
		const body = crawlRequestBody(pajamas, pajamas.fallbackStartUrl ?? "");
		expect(body.url).toBe("https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com");
	});
});

describe("hitCrawlLimit", () => {
	const counts = (finished: number) => ({ total: finished, finished, skipped: 0, disallowed: 0, errored: 0 });

	it("is true when the crawl finished exactly the limit", () => {
		expect(hitCrawlLimit({ status: "completed", counts: counts(100_000) }, 4)).toBe(true);
	});

	it("is false when the crawl finished below the limit", () => {
		expect(hitCrawlLimit({ status: "completed", counts: counts(99_999) }, 4)).toBe(false);
		expect(hitCrawlLimit({ status: "completed", counts: counts(12) }, 12)).toBe(false);
	});

	it("is true when Cloudflare cancelled the job for limits", () => {
		expect(hitCrawlLimit({ status: "cancelled_due_to_limits", counts: counts(300) }, 0)).toBe(true);
	});

	it("is true when the usable page count would fill the index to the limit", () => {
		expect(hitCrawlLimit({ status: "completed", counts: counts(100_000) }, 100_000)).toBe(true);
	});
});
