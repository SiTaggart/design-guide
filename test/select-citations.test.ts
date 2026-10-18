import { describe, expect, it } from "vitest";
import { MAX_K, MIN_SEARCH_SCORE } from "../src/config/instance.ts";
import type { Citation } from "../src/config/types.ts";
import { selectCitations } from "../src/serve/select-citations.ts";

function hit(partial: Partial<Citation> & Pick<Citation, "url" | "score">): Citation {
	return {
		passage: partial.passage ?? "guidance",
		source: partial.source ?? "Paste",
		system: partial.system ?? "paste",
		url: partial.url,
		score: partial.score,
	};
}

describe("selectCitations", () => {
	it("drops scores under 0.6, llms index files, and duplicate pages, then sorts by similarity", () => {
		const selected = selectCitations([
			hit({ url: "https://paste-dsys.com/components/button/", score: 0.7, passage: "trailing slash" }),
			hit({ url: "https://paste-dsys.com/components/button", score: 0.91, passage: "best chunk" }),
			hit({ url: "https://paste-dsys.com/components/button-Xts9ZQlB", score: 0.8, passage: "hash copy" }),
			hit({ url: "https://paste-dsys.com/llms.txt", score: 0.99 }),
			hit({ url: "https://primer.style/button", score: 0.59, system: "primer", source: "Primer" }),
			hit({ url: "https://www.patternfly.org/components/alert", score: 0.88, system: "patternfly", source: "PatternFly" }),
		]);
		expect(selected.map((item) => item.score)).toEqual([0.91, 0.88]);
		expect(selected.map((item) => item.url)).toEqual([
			"https://paste-dsys.com/components/button",
			"https://www.patternfly.org/components/alert",
		]);
		expect(selected.every((item) => item.score >= MIN_SEARCH_SCORE)).toBe(true);
		expect(selected.some((item) => item.url.includes("llms"))).toBe(false);
	});

	it("caps an omitted k at 50 and a larger k at 50", () => {
		const citations = Array.from({ length: 60 }, (_, index) =>
			hit({
				url: `https://paste-dsys.com/components/item-${index}`,
				score: 0.6 + index / 1000,
			}),
		);
		expect(selectCitations(citations)).toHaveLength(MAX_K);
		expect(selectCitations(citations, 1)).toHaveLength(1);
		expect(selectCitations(citations, 80)).toHaveLength(MAX_K);
		expect(selectCitations(citations, 1)[0]?.url).toBe(selectCitations(citations)[0]?.url);
	});

	it("returns nothing when every score is under the floor, including a gibberish query with no match", () => {
		expect(selectCitations([])).toEqual([]);
		expect(selectCitations([hit({ url: "https://paste-dsys.com/components/button", score: 0.458 })])).toEqual([]);
	});
});
