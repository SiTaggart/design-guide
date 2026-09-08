import { describe, expect, it } from "vitest";
import { SEEDS } from "../src/config/seed.ts";
import { SYSTEM_IDS, type SystemId } from "../src/config/types.ts";
import { CURATED_TIP_START_URLS, isAntiSubsetUrl } from "./fixtures/curated-tip-start-urls.ts";

const DOCS_ROOTS: Record<SystemId, string> = {
	paste: "https://paste-dsys.com/",
	primer: "https://primer.style/",
	"react-spectrum": "https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/",
	carbon: "https://github.com/carbon-design-system/carbon",
	uswds: "https://designsystem.digital.gov/",
	govuk: "https://design-system.service.gov.uk/",
	nhs: "https://service-manual.nhs.uk/",
	antd: "https://ant.design/",
	"gitlab-pajamas": "https://design.gitlab.com/",
};

const A11Y_FILTER = /combo|listbox|list-box|select|accessib|a11y|keyboard|focus|dropdown/i;

describe("seed registry", () => {
	it("lists all nine locked systems and no others", () => {
		expect(SEEDS.map((seed) => seed.id)).toEqual([...SYSTEM_IDS]);
		expect(SEEDS).toHaveLength(9);
	});

	it("gives every system exactly one docs-root startUrl", () => {
		for (const seed of SEEDS) {
			expect(seed.startUrl).toBe(DOCS_ROOTS[seed.id]);
			expect(seed).not.toHaveProperty("startUrls");
		}
	});

	it("carries no per-seed limit, depth, or a11y-page include filters", () => {
		for (const seed of SEEDS) {
			expect(seed).not.toHaveProperty("limit");
			expect(seed).not.toHaveProperty("depth");
			for (const pattern of seed.includePatterns ?? []) {
				expect(pattern).not.toMatch(A11Y_FILTER);
			}
		}
	});

	it("keeps carbon and react-spectrum on their Apache GitHub corpora", () => {
		const carbon = SEEDS.find((seed) => seed.id === "carbon");
		const spectrum = SEEDS.find((seed) => seed.id === "react-spectrum");
		expect(carbon?.startUrl).toBe("https://github.com/carbon-design-system/carbon");
		expect(carbon?.startUrl).not.toContain("carbondesignsystem.com");
		expect(carbon?.render).toBe(false);
		expect(carbon?.includePatterns?.every((pattern) => pattern.startsWith("https://github.com/carbon-design-system/carbon"))).toBe(true);
		expect(spectrum?.startUrl).toBe(
			"https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/",
		);
		expect(spectrum?.startUrl).not.toContain("react-spectrum.adobe.com");
		expect(spectrum?.startUrl).not.toContain("/tree/");
		expect(spectrum?.startUrl).not.toContain("/blob/");
		expect(spectrum?.fallbackStartUrl).toBeUndefined();
		expect(spectrum?.render).toBe(false);
		expect(spectrum?.indexUrlSuffixes).toEqual([".md", ".mdx"]);
		expect(spectrum?.includePatterns).toEqual([
			"https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/",
			"https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/**",
		]);
		for (const pattern of spectrum?.includePatterns ?? []) {
			expect(pattern.startsWith("https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/")).toBe(
				true,
			);
		}
	});

	it("excludes the SIT-20 hard outs on every seed without eating react-spectrum.adobe.com", () => {
		for (const seed of SEEDS) {
			expect(seed.excludePatterns).toEqual(expect.arrayContaining([
				"https://spectrum.adobe.com/**",
				"https://carbondesignsystem.com/**",
			]));
			expect(seed.excludePatterns?.some((pattern) => pattern.includes("react-spectrum.adobe.com"))).toBe(
				false,
			);
			expect(seed.excludePatterns?.some((pattern) => pattern.includes("*spectrum.adobe.com*"))).toBe(
				false,
			);
		}
	});

	it("only falls back for gitlab-pajamas", () => {
		for (const seed of SEEDS) {
			if (seed.id === "gitlab-pajamas") {
				expect(seed.fallbackStartUrl).toBe("https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com");
			} else {
				expect(seed.fallbackStartUrl).toBeUndefined();
			}
		}
	});

	it("starts every web system except paste outside the old curated tip pages", () => {
		for (const seed of SEEDS) {
			expect(isAntiSubsetUrl(seed.startUrl, CURATED_TIP_START_URLS)).toBe(seed.id !== "paste");
		}
	});
});

describe("isAntiSubsetUrl", () => {
	const curated = ["https://example.test/components/select/", "https://Example.test/docs"];

	it("rejects a url that is in the curated list, ignoring trailing slash and case", () => {
		expect(isAntiSubsetUrl("https://example.test/components/select", curated)).toBe(false);
		expect(isAntiSubsetUrl("https://example.test/docs/", curated)).toBe(false);
	});

	it("accepts a url outside the curated list", () => {
		expect(isAntiSubsetUrl("https://example.test/", curated)).toBe(true);
		expect(isAntiSubsetUrl("https://example.test/components/", curated)).toBe(true);
	});
});
