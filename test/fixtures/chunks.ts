import type { SearchChunk } from "../../src/config/types.ts";

export const fixtureChunks: SearchChunk[] = [
	{
		text: "ComboBox supports arrow keys, Enter to select, and Escape to close. Focus stays on the input while the listbox is open.",
		item: {
			key: "paste/gen/aaaa.md",
			metadata: {
				system: "paste",
				source: "Paste",
				source_url: "https://paste-dsys.com/",
			},
		},
	},
	{
		text: "Select keeps keyboard focus in the text input. Arrow keys move active descendant in the listbox without shifting DOM focus.",
		item: {
			key: "primer/gen/bbbb.md",
			metadata: {
				system: "primer",
				source: "Primer",
				source_url: "https://primer.style/product/components/select/react/accessibility",
			},
		},
	},
	{
		text: "USWDS combo box documents keyboard interaction for the input and listbox, including focus visible on the selected option.",
		item: {
			key: "uswds/gen/cccc.md",
			metadata: {
				system: "uswds",
				source: "USWDS",
				source_url: "https://designsystem.digital.gov/components/combo-box/",
			},
		},
	},
];

export const invalidChunks: SearchChunk[] = [
	{ text: "   ", item: { metadata: { source: "X", source_url: "https://example.com/" } } },
	{ text: "kept out", item: { metadata: { source: "", source_url: "https://example.com/" } } },
	{
		text: "http only",
		item: { metadata: { source: "X", source_url: "http://example.com/insecure" } },
	},
	{ text: "no url", item: { metadata: { source: "X" } } },
];
