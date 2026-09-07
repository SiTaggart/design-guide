import type { Seed, SystemId } from "./types.ts";

const A11Y_PATTERNS = [
	"**/*combo*",
	"**/*listbox*",
	"**/*list-box*",
	"**/*select*",
	"**/*accessib*",
	"**/*a11y*",
	"**/*keyboard*",
	"**/*focus*",
	"**/*dropdown*",
];

export const SEEDS: readonly Seed[] = [
	{
		id: "paste",
		source: "Paste",
		startUrls: ["https://paste-dsys.com/"],
		includePatterns: A11Y_PATTERNS,
		limit: 12,
		depth: 2,
		includeSubdomains: true,
	},
	{
		id: "primer",
		source: "Primer",
		startUrls: [
			"https://primer.style/product/components/select/react/accessibility",
			"https://primer.style/product/components/selectpanel/react/accessibility",
			"https://primer.style/product/components/action-list/react/accessibility",
		],
		includePatterns: A11Y_PATTERNS,
		limit: 12,
		depth: 2,
	},
	{
		id: "react-spectrum",
		source: "React Spectrum",
		startUrls: [
			"https://react-spectrum.adobe.com/react-aria/ComboBox.html",
			"https://react-spectrum.adobe.com/react-aria/ListBox.html",
			"https://react-spectrum.adobe.com/react-aria/Select.html",
		],
		includePatterns: [
			"**/*ComboBox*",
			"**/*ListBox*",
			"**/*Select*",
			"**/*accessib*",
			"**/*keyboard*",
			"**/*focus*",
		],
		excludePatterns: ["**/*spectrum.adobe.com*"],
		limit: 10,
		depth: 1,
	},
	{
		id: "carbon",
		source: "Carbon",
		startUrls: [
			"https://github.com/carbon-design-system/carbon/tree/main/packages/react/src/components/ComboBox",
			"https://github.com/carbon-design-system/carbon/tree/main/packages/react/src/components/ListBox",
			"https://raw.githubusercontent.com/carbon-design-system/carbon/main/packages/react/src/components/ComboBox/ComboBox.mdx",
			"https://raw.githubusercontent.com/carbon-design-system/carbon/main/packages/react/src/components/ListBox/ListBox.mdx",
		],
		includePatterns: ["**/*ComboBox*", "**/*ListBox*", "**/*combo*", "**/*listbox*"],
		excludePatterns: ["**/*carbondesignsystem.com*"],
		limit: 10,
		depth: 1,
		render: false,
	},
	{
		id: "uswds",
		source: "USWDS",
		startUrls: [
			"https://designsystem.digital.gov/components/combo-box/",
			"https://designsystem.digital.gov/components/select/",
		],
		includePatterns: A11Y_PATTERNS,
		limit: 8,
		depth: 1,
	},
	{
		id: "govuk",
		source: "GOV.UK Design System",
		startUrls: [
			"https://design-system.service.gov.uk/components/select/",
			"https://design-system.service.gov.uk/styles/focus-state/",
		],
		includePatterns: A11Y_PATTERNS,
		limit: 8,
		depth: 1,
	},
	{
		id: "nhs",
		source: "NHS service manual",
		startUrls: [
			"https://service-manual.nhs.uk/design-system/components/select",
			"https://service-manual.nhs.uk/accessibility/how-to-make-content-accessible",
		],
		includePatterns: A11Y_PATTERNS,
		limit: 8,
		depth: 1,
	},
	{
		id: "antd",
		source: "Ant Design",
		startUrls: [
			"https://ant.design/components/select",
			"https://ant.design/components/auto-complete",
		],
		includePatterns: ["**/*select*", "**/*auto-complete*", "**/*accessib*", "**/*keyboard*"],
		limit: 8,
		depth: 1,
	},
	{
		id: "gitlab-pajamas",
		source: "Pajamas",
		startUrls: [
			"https://design.gitlab.com/components/dropdown-combobox/",
			"https://design.gitlab.com/components/listbox/",
		],
		fallbackStartUrls: [
			"https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com/-/tree/main/contents/components",
		],
		includePatterns: A11Y_PATTERNS,
		limit: 10,
		depth: 2,
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
