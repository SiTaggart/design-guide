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

	it("puts the named component page ahead of a higher score, with the API page still below", () => {
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
		const api = hit({
			url: "https://paste-dsys.com/components/button/api",
			score: 0.99,
			passage: "Button props",
		});
		const foreign = hit({
			url: "https://www.patternfly.org/components/button",
			score: 0.97,
			system: "patternfly",
			source: "PatternFly",
		});
		const ranked = rankCitations([api, foreign, button, wizard], "Paste button guidance");
		expect(ranked.map((item) => item.url)).toEqual([button.url, wizard.url, api.url, foreign.url]);
		expect(rankCitations([wizard, button], "what are the best practices for displaying error messages")[0]?.url).toBe(
			wizard.url,
		);
	});

	it("names every indexed system from the seed catalog and does not treat Carbon as one", () => {
		expect(rankCitations(
			[
				hit({ url: "https://ix.siemens.io/docs/components/button/guide", score: 0.7, system: "siemens-ix", source: "Siemens iX" }),
				hit({ url: "https://www.patternfly.org/components/button", score: 0.95, system: "patternfly", source: "PatternFly" }),
			],
			"siemens button guide",
		)[0]?.system).toBe("siemens-ix");
		expect(rankCitations(
			[
				hit({ url: "https://design-system.service.gov.uk/components/button/", score: 0.7, system: "govuk", source: "GOV.UK Design System" }),
				hit({ url: "https://paste-dsys.com/components/button", score: 0.95, system: "paste", source: "Paste" }),
			],
			"gov.uk button guidance",
		)[0]?.system).toBe("govuk");
		expect(rankCitations(
			[
				hit({ url: "https://carbondesignsystem.com/components/modal", score: 0.7, system: "carbon", source: "Carbon" }),
				hit({ url: "https://primer.style/product/components/dialog", score: 0.8, system: "primer", source: "Primer" }),
			],
			"carbon modal guidance",
		)[0]?.system).toBe("primer");
	});

	it("lets a higher-scoring Primer button page lose to the Paste button page", () => {
		const primer = hit({
			url: "https://primer.style/product/components/button",
			score: 0.99,
			system: "primer",
			source: "Primer",
			passage: "Use a button to start an action.",
		});
		const paste = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.7,
			system: "paste",
			source: "Paste",
			passage: "Buttons show the actions available on a page.",
		});
		const ranked = rankCitations([primer, paste], "Paste button guidance");
		expect(ranked[0]?.system).toBe("paste");
		expect(ranked[0]?.url).toBe(paste.url);
	});

	it("does not cite an llms.txt index file", () => {
		const index = hit({
			url: "https://cloudscape.design/llms.txt",
			score: 0.99,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "Cloudscape component index",
		});
		const full = hit({
			url: "https://cloudscape.design/llms-full.txt",
			score: 0.98,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "Cloudscape full index",
		});
		const about = hit({
			url: "https://cloudscape.design/gen-ai/ai-tools/llms-txt-files/",
			score: 0.85,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "How to use the llms.txt index.",
		});
		const table = hit({
			url: "https://cloudscape.design/components/table/",
			score: 0.7,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "A table displays rows of data.",
		});
		const ranked = rankCitations([index, full, about, table], "cloudscape table guidance");
		expect(ranked.map((item) => item.url)).toEqual([table.url, about.url]);
	});

	it("puts the named component's own page ahead of a higher score from the same system", () => {
		const wizard = hit({
			url: "https://paste-dsys.com/page-templates/wizard",
			score: 0.984,
			passage: "The wizard includes a Button.",
		});
		const button = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.771,
			passage: "Buttons show the actions available on a page.",
		});
		expect(rankCitations([wizard, button], "Paste button guidance")[0]?.url).toBe(button.url);

		const tools = hit({
			url: "https://cloudscape.design/get-started/for-developers/ai-tools-support/",
			score: 0.88,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "Use the docs with an AI tool.",
		});
		const table = hit({
			url: "https://cloudscape.design/components/table/",
			score: 0.62,
			system: "cloudscape",
			source: "Cloudscape",
			passage: "A table displays rows of data.",
		});
		expect(rankCitations([tools, table], "cloudscape table guidance")[0]?.url).toBe(table.url);

		const create = hit({
			url: "https://primer.style/product/scenario-patterns/create",
			score: 0.93,
			system: "primer",
			source: "Primer",
			passage: "Create a resource.",
		});
		const dialog = hit({
			url: "https://primer.style/product/components/dialog/guidelines/",
			score: 0.86,
			system: "primer",
			source: "Primer",
			passage: "Dialogs keep focus inside the modal.",
		});
		expect(rankCitations([create, dialog], "primer dialog guidance")[0]?.url).toBe(dialog.url);
	});

	it("matches a plural query word to the singular component path", () => {
		const wizard = hit({
			url: "https://paste-dsys.com/page-templates/wizard",
			score: 0.984,
			passage: "The wizard includes a Button.",
		});
		const button = hit({
			url: "https://paste-dsys.com/components/button",
			score: 0.771,
			passage: "Buttons show the actions available on a page.",
		});
		expect(rankCitations([wizard, button], "Paste buttons guidance")[0]?.url).toBe(button.url);
		expect(rankCitations([wizard, button], "Paste guidance for buttons")[0]?.url).toBe(button.url);
	});

	it("drops a fused score of 1 when the reranker score is below the floor", () => {
		const ranked = rankCitations(
			[hit({ url: "https://paste-dsys.com/components/form", score: 0.01, passage: "junk" })],
			"zzqxv quantum flux capacitor sandwich",
		);
		expect(ranked).toEqual([]);
	});
});
