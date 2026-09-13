import { describe, expect, it } from "vitest";
import { mapChunks } from "../src/serve/map-chunks.ts";
import { fixtureChunks, invalidChunks } from "./fixtures/chunks.ts";

const fixtureCitations = [
	{
		passage:
			"ComboBox supports arrow keys, Enter to select, and Escape to close. Focus stays on the input while the listbox is open.",
		source: "Paste",
		url: "https://paste-dsys.com/",
		system: "paste",
		score: 0.81,
	},
	{
		passage:
			"Select keeps keyboard focus in the text input. Arrow keys move active descendant in the listbox without shifting DOM focus.",
		source: "Primer",
		url: "https://primer.style/product/components/select/react/accessibility",
		system: "primer",
		score: 0.72,
	},
	{
		passage:
			"USWDS combo box documents keyboard interaction for the input and listbox, including focus visible on the selected option.",
		source: "USWDS",
		url: "https://designsystem.digital.gov/components/combo-box/",
		system: "uswds",
		score: 0.65,
	},
];

describe("mapChunks", () => {
	it("copies passage text, https metadata, and the AI Search score without rewriting", () => {
		expect(mapChunks(fixtureChunks)).toEqual(fixtureCitations);
	});

	it("drops empty passages, empty sources, and non-https urls", () => {
		expect(mapChunks(invalidChunks)).toEqual([]);
	});

	it("returns an empty list when the index is empty", () => {
		expect(mapChunks([])).toEqual([]);
	});

	it("uses the item key when source metadata is missing", () => {
		const mapped = mapChunks([
			{
				text: "keyboard focus remains on the combobox input",
				score: 0.7,
				item: {
					key: "govuk/gen/dddd.md",
					metadata: {
						source_url: "https://design-system.service.gov.uk/components/select/",
					},
				},
			},
		]);
		expect(mapped).toEqual([
			{
				passage: "keyboard focus remains on the combobox input",
				source: "govuk/gen/dddd.md",
				url: "https://design-system.service.gov.uk/components/select/",
				system: "",
				score: 0.7,
			},
		]);
	});

	it("keeps a score of 0.6 and drops a score of 0.59", () => {
		const kept = {
			text: "boundary keep",
			score: 0.6,
			item: {
				metadata: {
					system: "primer",
					source: "Primer",
					source_url: "https://primer.style/",
				},
			},
		};
		const dropped = {
			text: "just below",
			score: 0.59,
			item: {
				metadata: {
					system: "uswds",
					source: "USWDS",
					source_url: "https://designsystem.digital.gov/",
				},
			},
		};
		expect(mapChunks([kept, dropped])).toEqual([
			{
				passage: "boundary keep",
				source: "Primer",
				url: "https://primer.style/",
				system: "primer",
				score: 0.6,
			},
		]);
	});

	it("drops missing, string, out-of-range, and NaN scores without inventing a value", () => {
		const metadata = {
			system: "primer",
			source: "Primer",
			source_url: "https://primer.style/",
		};
		expect(
			mapChunks([
				{ text: "kept", score: 0.9, item: { metadata } },
				{ text: "missing score", item: { metadata } },
				{ text: "string score", score: "0.9", item: { metadata } },
				{ text: "out of range", score: 1.1, item: { metadata } },
				{ text: "nan score", score: Number.NaN, item: { metadata } },
			]),
		).toEqual([
			{
				passage: "kept",
				source: "Primer",
				url: "https://primer.style/",
				system: "primer",
				score: 0.9,
			},
		]);
	});
});
