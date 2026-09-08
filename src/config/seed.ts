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
		id: "react-spectrum",
		source: "React Spectrum",
		startUrl: "https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/",
		includePatterns: [
			"https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/",
			"https://cdn.jsdelivr.net/gh/adobe/react-spectrum@main/packages/dev/s2-docs/pages/**",
		],
		excludePatterns: HARD_OUTS,
		indexUrlSuffixes: [".md", ".mdx"],
		render: false,
	},
	{
		id: "carbon",
		source: "Carbon",
		startUrl: "https://github.com/carbon-design-system/carbon",
		includePatterns: [
			"https://github.com/carbon-design-system/carbon",
			"https://github.com/carbon-design-system/carbon/**",
		],
		excludePatterns: HARD_OUTS,
		render: false,
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
];

const BY_ID = new Map(SEEDS.map((seed) => [seed.id, seed]));

export function seedById(id: SystemId): Seed {
	const seed = BY_ID.get(id);
	if (!seed) {
		throw new Error(`unknown seed ${id}`);
	}
	return seed;
}
