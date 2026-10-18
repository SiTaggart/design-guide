import type { SearchChunk } from "../../src/config/types.ts";

export function withRerank(chunk: SearchChunk, score?: number): SearchChunk {
	const value = score ?? chunk.scoring_details?.reranking_score ?? chunk.score;
	return {
		...chunk,
		scoring_details: { ...chunk.scoring_details, reranking_score: value },
	};
}

export const fixtureChunks: SearchChunk[] = [
	{
		text: "ComboBox supports arrow keys, Enter to select, and Escape to close. Focus stays on the input while the listbox is open.",
		score: 0.81,
		scoring_details: { reranking_score: 0.81, vector_score: 0.7 },
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
		score: 0.72,
		scoring_details: { reranking_score: 0.72, vector_score: 0.6 },
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
		score: 0.65,
		scoring_details: { reranking_score: 0.65, vector_score: 0.5 },
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
	{
		text: "   ",
		score: 0.9,
		scoring_details: { reranking_score: 0.9 },
		item: { metadata: { source: "X", source_url: "https://example.com/" } },
	},
	{
		text: "kept out",
		score: 0.9,
		scoring_details: { reranking_score: 0.9 },
		item: { metadata: { source: "", source_url: "https://example.com/" } },
	},
	{
		text: "http only",
		score: 0.9,
		scoring_details: { reranking_score: 0.9 },
		item: { metadata: { source: "X", source_url: "http://example.com/insecure" } },
	},
	{ text: "no url", score: 0.9, scoring_details: { reranking_score: 0.9 }, item: { metadata: { source: "X" } } },
];
