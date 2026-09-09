export const CURATED_TIP_START_URLS: readonly string[] = [
	"https://paste-dsys.com/",
	"https://primer.style/product/components/select/react/accessibility",
	"https://primer.style/product/components/selectpanel/react/accessibility",
	"https://primer.style/product/components/action-list/react/accessibility",
	"https://react-spectrum.adobe.com/react-aria/ComboBox.html",
	"https://react-spectrum.adobe.com/react-aria/ListBox.html",
	"https://react-spectrum.adobe.com/react-aria/Select.html",
	"https://github.com/carbon-design-system/carbon/tree/main/packages/react/src/components/ComboBox",
	"https://github.com/carbon-design-system/carbon/tree/main/packages/react/src/components/ListBox",
	"https://raw.githubusercontent.com/carbon-design-system/carbon/main/packages/react/src/components/ComboBox/ComboBox.mdx",
	"https://raw.githubusercontent.com/carbon-design-system/carbon/main/packages/react/src/components/ListBox/ListBox.mdx",
	"https://designsystem.digital.gov/components/combo-box/",
	"https://designsystem.digital.gov/components/select/",
	"https://design-system.service.gov.uk/components/select/",
	"https://design-system.service.gov.uk/styles/focus-state/",
	"https://service-manual.nhs.uk/design-system/components/select",
	"https://service-manual.nhs.uk/accessibility/how-to-make-content-accessible",
	"https://ant.design/components/select",
	"https://ant.design/components/auto-complete",
	"https://design.gitlab.com/components/dropdown-combobox/",
	"https://design.gitlab.com/components/listbox/",
];

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function isAntiSubsetUrl(url: string, curated: readonly string[]): boolean {
	const target = normalizeUrl(url);
	return curated.every((candidate) => normalizeUrl(candidate) !== target);
}
