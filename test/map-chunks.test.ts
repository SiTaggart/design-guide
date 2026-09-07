import { describe, expect, it } from "vitest";
import { mapChunks } from "../src/serve/map-chunks.ts";
import { fixtureChunks, invalidChunks } from "./fixtures/chunks.ts";

describe("mapChunks", () => {
	it("copies passage text and https metadata without rewriting", () => {
		const [first] = mapChunks(fixtureChunks);
		expect(first.passage).toBe(fixtureChunks[0].text);
		expect(first.source).toBe("React Spectrum");
		expect(first.url).toBe("https://react-spectrum.adobe.com/react-aria/ComboBox.html");
		expect(first.system).toBe("react-spectrum");
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
			},
		]);
	});
});
