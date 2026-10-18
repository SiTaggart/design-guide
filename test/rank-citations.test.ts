import { describe, expect, it } from "vitest";
import type { Citation } from "../src/config/types.ts";
import { isReferencePage, normalizePageUrl, rankCitations } from "../src/serve/rank-citations.ts";

function hit(partial: Partial<Citation> & Pick<Citation, "url" | "score">): Citation {
	return {
		passage: partial.passage ?? "guidance",
		source: partial.source ?? "Paste",
		url: partial.url,
		system: partial.system ?? "paste",
		score: partial.score,
	};
}

describe("rankCitations", () => {
	it("drops scores below 0.6, dedupes a normalized url, and returns best first", () => {
		const ranked = rankCitations(
			[
				hit({ url: "https://paste-dsys.com/components/button/", score: 0.7, passage: "button guidance" }),
				hit({ url: "https://paste-dsys.com/components/button", score: 0.91, passage: "stronger button guidance" }),
				hit({ url: "https://paste-dsys.com/components/button-Xts9ZQlB", score: 0.8, passage: "hash copy" }),
				hit({ url: "https://primer.style/button.html", score: 0.59, system: "primer", source: "Primer" }),
				hit({ url: "https://www.patternfly.org/components/button.md", score: 0.88, system: "patternfly", source: "PatternFly" }),
			],
			"button hierarchy",
		);
		expect(ranked.map((item) => item.score)).toEqual([0.91, 0.88]);
		expect(ranked.map((item) => normalizePageUrl(item.url))).toEqual([
			"https://paste-dsys.com/components/button",
			"https://www.patternfly.org/components/button",
		]);
	});

	it("lets k only shorten the list and treats an omitted k as the 50 cap", () => {
		const citations = Array.from({ length: 3 }, (_, index) =>
			hit({
				url: `https://paste-dsys.com/page-${index}`,
				score: 0.9 - index / 100,
				system: index === 1 ? "primer" : "paste",
			}),
		);
		expect(rankCitations(citations, "loading content")).toHaveLength(3);
		expect(rankCitations(citations, "loading content", 1)).toHaveLength(1);
		expect(rankCitations(citations, "loading content", 1)[0]?.url).toBe(rankCitations(citations, "loading content")[0]?.url);
	});

	it("sorts api, props, and token tables below guidance without changing the score", () => {
		const guidance = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.7,
			passage: "Use a primary button for the main action.",
		});
		const api = hit({
			url: "https://paste-dsys.com/components/button/api",
			score: 0.95,
			passage: "Button props",
		});
		const table = hit({
			url: "https://www.patternfly.org/components/button",
			score: 0.93,
			system: "patternfly",
			source: "PatternFly",
			passage: "| prop | type | default | required | description | notes | extra | more |\n| variant | string | primary | yes | visual style | tokens | a | b |",
		});
		const ranked = rankCitations([api, table, guidance], "button hierarchy");
		expect(isReferencePage(api.url, api.passage)).toBe(true);
		expect(isReferencePage(table.url, table.passage)).toBe(true);
		expect(ranked[0]?.url).toBe(guidance.url);
		expect(ranked.map((item) => item.score)).toEqual([0.7, 0.95, 0.93]);
	});

	it("puts the named system's pages ahead of a higher score from any other system", () => {
		const cloudscape = hit({
			url: "https://cloudscape.design/components/table",
			score: 0.7,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "Use a table to scan rows of data.",
		});
		const patternfly = hit({
			url: "https://www.patternfly.org/components/table",
			score: 0.95,
			system: "patternfly",
			source: "PatternFly",
			passage: "Tables show large data sets.",
		});
		expect(rankCitations([patternfly, cloudscape], "cloudscape table guidance")[0]?.system).toBe("cloudscape");

		const primer = hit({
			url: "https://primer.style/product/components/dialog",
			score: 0.66,
			system: "primer",
			source: "Primer",
			passage: "Dialogs keep focus inside the modal.",
		});
		const other = hit({
			url: "https://cloudscape.design/components/modal",
			score: 0.97,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "A modal dialog traps focus.",
		});
		expect(rankCitations([other, primer], "primer dialog guidance")[0]?.system).toBe("primer");

		const paste = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.7,
			system: "paste",
			source: "Paste",
			passage: "Buttons show the actions available on a page.",
		});
		const foreign = hit({
			url: "https://www.patternfly.org/components/button",
			score: 0.99,
			system: "patternfly",
			source: "PatternFly",
			passage: "A button starts an action.",
		});
		expect(rankCitations([foreign, paste], "how does Paste say to use buttons")[0]?.system).toBe("paste");
	});

	it("orders one system's pages by reranker score when the query names that system", () => {
		const wizard = hit({
			url: "https://paste-dsys.com/page-templates/wizard",
			score: 0.98,
			passage: "The wizard includes a Button.",
		});
		const button = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.77,
			passage: "Buttons show the actions available on a page.",
		});
		expect(rankCitations([wizard, button], "Paste button guidance")[0]?.url).toBe(button.url);
		expect(rankCitations([wizard, button], "what are the best practices for displaying error messages")[0]?.url).toBe(
			wizard.url,
		);
	});

	it("drops a fused score of 1 when the reranker score is below the floor", () => {
		const ranked = rankCitations(
			[hit({ url: "https://paste-dsys.com/components/form", score: 0.01, passage: "junk" })],
			"zzqxv quantum flux capacitor sandwich",
		);
		expect(ranked).toEqual([]);
	});
});
