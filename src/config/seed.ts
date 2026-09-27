import type { Seed, SystemId } from "./types.ts";

const HARD_OUTS = [
	"https://spectrum.adobe.com",
	"https://spectrum.adobe.com/**",
	"https://www.spectrum.adobe.com",
	"https://www.spectrum.adobe.com/**",
	"https://carbondesignsystem.com",
	"https://carbondesignsystem.com/**",
	"https://www.carbondesignsystem.com",
	"https://www.carbondesignsystem.com/**",
];

export const SEEDS: readonly Seed[] = [
	{
		id: "paste",
		source: "Paste",
		startUrl: "https://paste-dsys.com/",
		excludePatterns: HARD_OUTS,
	},
	{
		id: "primer",
		source: "Primer",
		startUrl: "https://primer.style/",
		excludePatterns: HARD_OUTS,
	},
	{
		id: "uswds",
		source: "USWDS",
		startUrl: "https://designsystem.digital.gov/",
		includePatterns: ["https://designsystem.digital.gov/**"],
		excludePatterns: HARD_OUTS,
	},
	{
		id: "govuk",
		source: "GOV.UK Design System",
		startUrl: "https://design-system.service.gov.uk/",
		excludePatterns: HARD_OUTS,
	},
	{
		id: "nhs",
		source: "NHS service manual",
		startUrl: "https://service-manual.nhs.uk/",
		excludePatterns: HARD_OUTS,
	},
	{
		id: "antd",
		source: "Ant Design",
		startUrl: "https://ant.design/",
		excludePatterns: HARD_OUTS,
	},
	{
		id: "gitlab-pajamas",
		source: "Pajamas",
		startUrl: "https://design.gitlab.com/",
		fallbackStartUrl: "https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com",
		excludePatterns: HARD_OUTS,
	},
	// Archie sitemap 681.
	{
		id: "patternfly",
		source: "PatternFly",
		startUrl: "https://www.patternfly.org/",
		excludePatterns: HARD_OUTS,
	},
	// Archie sitemap 285.
	{
		id: "cloudscape",
		source: "Cloudscape",
		startUrl: "https://cloudscape.design/",
		excludePatterns: HARD_OUTS,
	},
	// No sitemap. Archie counted 114 hrefs under /docs.
	{
		id: "vanilla",
		source: "Vanilla Framework",
		startUrl: "https://vanillaframework.io/docs/",
		excludePatterns: HARD_OUTS,
	},
	// llms.txt crawl finished 1 page and 0 usable records. Browser Run did not follow the 282 markdown links. HTML overview + sitemap (383) is the working start.
	{
		id: "siemens-ix",
		source: "Siemens iX",
		startUrl: "https://ix.siemens.io/docs/home/overview",
		includePatterns: ["https://ix.siemens.io/docs/**"],
		excludePatterns: HARD_OUTS,
	},
	// Include /latest/*. Public sitemap has 393 URLs.
	{
		id: "backpack",
		source: "Backpack",
		startUrl: "https://www.skyscanner.design/latest/welcome-to-backpack-Mtf5OEo4",
		includePatterns: ["https://www.skyscanner.design/latest/**"],
		excludePatterns: HARD_OUTS,
	},
	// Sitemap is 79 from /. Start at /components. Product check on reindex output is at least half the sitemap, and at least 40 when that half is under 50.
	{
		id: "garden",
		source: "Zendesk Garden",
		startUrl: "https://garden.zendesk.com/components",
		excludePatterns: HARD_OUTS,
	},
	// Include */orange/docs/1.5/*. Exclude */docs/0.4/*.
	{
		id: "ouds-web",
		source: "OUDS Web",
		startUrl: "https://web.unified-design-system.orange.com/orange/",
		includePatterns: [
			"https://web.unified-design-system.orange.com/orange/",
			"https://web.unified-design-system.orange.com/orange/**",
			"**/orange/docs/1.5/**",
		],
		excludePatterns: [...HARD_OUTS, "**/docs/0.4/**"],
	},
];

const BY_ID = new Map(SEEDS.map((seed) => [seed.id, seed]));

export function seedById(id: SystemId): Seed {
	const seed = BY_ID.get(id);
	if (!seed) {
		throw new Error(`unknown seed ${id}`);
	}
	return seed;
}
