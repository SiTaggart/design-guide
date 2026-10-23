import { describe, expect, it } from "vitest";
import { BROWSER_CRAWL_DEPTH, BROWSER_CRAWL_LIMIT, CRAWL_RUNAWAY_PAGES } from "../src/config/instance.ts";
import { seedById } from "../src/config/seed.ts";
import type { Seed } from "../src/config/types.ts";
import { crawlRequestBody, crawlStoppedEarly, reachedRunawayCeiling } from "../src/crawl/browser-run.ts";

describe("crawlRequestBody", () => {
	it("asks Browser Run for its maximum page limit and depth", () => {
		const body = crawlRequestBody(seedById("primer"), "https://primer.style/");
		expect(BROWSER_CRAWL_LIMIT).toBe(100_000);
		expect(BROWSER_CRAWL_DEPTH).toBe(100_000);
		expect(body).toEqual({
			url: "https://primer.style/",
			source: "all",
			limit: BROWSER_CRAWL_LIMIT,
			depth: BROWSER_CRAWL_DEPTH,
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

	it("never sends rejectResourceTypes", () => {
		for (const seed of ["primer", "uswds"] as const) {
			const json = JSON.stringify(crawlRequestBody(seedById(seed), seedById(seed).startUrl));
			expect(json).not.toContain("rejectResourceTypes");
		}
		expect(crawlRequestBody(seedById("primer"), seedById("primer").startUrl).render).toBe(true);
	});

	it("omits includePatterns when the seed has none or an empty list", () => {
		expect(crawlRequestBody(seedById("govuk"), "https://design-system.service.gov.uk/").options).not.toHaveProperty(
			"includePatterns",
		);
		const emptied: Seed = { ...seedById("govuk"), includePatterns: [] };
		expect(crawlRequestBody(emptied, emptied.startUrl).options).not.toHaveProperty("includePatterns");
	});

	it("keeps the host-scope includePatterns for uswds", () => {
		expect(crawlRequestBody(seedById("uswds"), seedById("uswds").startUrl).options.includePatterns).toEqual([
			"https://designsystem.digital.gov/**",
		]);
	});

	it("passes includePatterns through for backpack, siemens-ix, and ouds-web", () => {
		expect(crawlRequestBody(seedById("backpack"), seedById("backpack").startUrl).options.includePatterns).toEqual([
			"https://www.skyscanner.design/latest/**",
		]);
		expect(crawlRequestBody(seedById("siemens-ix"), seedById("siemens-ix").startUrl).options.includePatterns).toEqual([
			"https://ix.siemens.io/docs/**",
		]);
		expect(crawlRequestBody(seedById("ouds-web"), seedById("ouds-web").startUrl).options.includePatterns).toEqual([
			"https://web.unified-design-system.orange.com/orange/",
			"https://web.unified-design-system.orange.com/orange/**",
			"**/orange/docs/1.5/**",
		]);
	});

	it("uses the start url it is handed so a fallback crawl reports the fallback", () => {
		const pajamas = seedById("gitlab-pajamas");
		const body = crawlRequestBody(pajamas, pajamas.fallbackStartUrl ?? "");
		expect(body.url).toBe("https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com");
	});

	it("scopes a fallback start to the project prefix and keeps exclude patterns", () => {
		const pajamas = seedById("gitlab-pajamas");
		const prefix = "https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com";
		const primary = crawlRequestBody(pajamas, pajamas.startUrl);
		expect(primary.options).not.toHaveProperty("includePatterns");
		expect(crawlRequestBody(pajamas, prefix).options).toMatchObject({
			includeExternalLinks: false,
			includeSubdomains: false,
			includePatterns: [prefix, `${prefix}/**`],
			excludePatterns: pajamas.excludePatterns,
		});
	});
});

describe("crawl bounds", () => {
	it("treats a limit cancellation or a full Browser Run result as an early stop", () => {
		expect(crawlStoppedEarly("cancelled_due_to_limits", 300)).toBe(true);
		expect(crawlStoppedEarly("completed", BROWSER_CRAWL_LIMIT)).toBe(true);
		expect(crawlStoppedEarly("completed", 12)).toBe(false);
		expect(crawlStoppedEarly("errored", BROWSER_CRAWL_LIMIT)).toBe(false);
	});

	it("treats the safety ceiling as incomplete", () => {
		expect(CRAWL_RUNAWAY_PAGES).toBe(10_000);
		expect(reachedRunawayCeiling(CRAWL_RUNAWAY_PAGES)).toBe(true);
		expect(reachedRunawayCeiling(CRAWL_RUNAWAY_PAGES - 1)).toBe(false);
	});
});
