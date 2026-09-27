import { describe, expect, it } from "vitest";
import { SEEDS } from "../src/config/seed.ts";
import { SYSTEM_IDS, type SystemId } from "../src/config/types.ts";
import { CURATED_TIP_START_URLS, isAntiSubsetUrl } from "./fixtures/curated-tip-start-urls.ts";

const DOCS_ROOTS: Record<SystemId, string> = {
	paste: "https://paste-dsys.com/",
	primer: "https://primer.style/",
	uswds: "https://designsystem.digital.gov/",
	govuk: "https://design-system.service.gov.uk/",
	nhs: "https://service-manual.nhs.uk/",
	antd: "https://ant.design/",
	"gitlab-pajamas": "https://design.gitlab.com/",
	patternfly: "https://www.patternfly.org/",
	cloudscape: "https://cloudscape.design/",
	vanilla: "https://vanillaframework.io/docs/",
	"siemens-ix": "https://ix.siemens.io/docs/home/overview",
	backpack: "https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4",
	garden: "https://garden.zendesk.com/",
	"ouds-web": "https://web.unified-design-system.orange.com/orange/",
};

const A11Y_FILTER = /combo|listbox|list-box|select|accessib|a11y|keyboard|focus|dropdown/i;

describe("seed registry", () => {
	it("lists all fourteen locked systems and no others", () => {
		expect(SEEDS.map((seed) => seed.id)).toEqual([...SYSTEM_IDS]);
		expect(SEEDS).toHaveLength(14);
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

	it("locks Archie scope for siemens-ix, backpack, ouds-web, and garden", () => {
		const siemens = SEEDS.find((seed) => seed.id === "siemens-ix");
		expect(siemens?.startUrl).toBe("https://ix.siemens.io/docs/home/overview");
		expect(siemens?.fallbackStartUrl).toBeUndefined();
		expect(siemens?.indexUrlSuffixes).toBeUndefined();
		expect(siemens?.includePatterns).toEqual(["https://ix.siemens.io/docs/**"]);

		expect(SEEDS.find((seed) => seed.id === "backpack")?.includePatterns).toEqual([
			"https://www.skyscanner.design/latest/**",
		]);

		const ouds = SEEDS.find((seed) => seed.id === "ouds-web");
		expect(ouds?.includePatterns).toEqual([
			"https://web.unified-design-system.orange.com/orange/",
			"https://web.unified-design-system.orange.com/orange/**",
			"**/orange/docs/1.5/**",
		]);
		expect(ouds?.excludePatterns?.slice(0, -1)).toEqual(
			SEEDS.find((seed) => seed.id === "paste")?.excludePatterns,
		);
		expect(ouds?.excludePatterns?.at(-1)).toBe("**/docs/0.4/**");

		expect(SEEDS.find((seed) => seed.id === "garden")?.startUrl).toBe("https://garden.zendesk.com/");

		const ids = SEEDS.map((seed) => seed.id);
		expect(ids).not.toContain("carbon");
		expect(ids).not.toContain("fluent2");
		expect(ids).not.toContain("bootstrap");
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
