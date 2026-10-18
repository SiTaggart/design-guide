import { describe, expect, it } from "vitest";
import type { Citation } from "../src/config/types.ts";
import { MIN_SEARCH_SCORE } from "../src/config/instance.ts";
import { isReferencePage, rankCitations } from "../src/serve/rank-citations.ts";
import candidates from "./fixtures/eval-candidates.json";
import { EVAL_QUERIES, NONSENSE_QUERIES } from "./fixtures/eval-queries.ts";

type CandidateFile = {
	id: string;
	query: string;
	hits: Citation[];
};

const measured = new Map((candidates as CandidateFile[]).map((row) => [row.id, row]));

function rankedFor(id: string, query: string): Citation[] {
	const row = measured.get(id);
	if (!row) {
		throw new Error(`missing measured candidates for ${id}`);
	}
	expect(row.query).toBe(query);
	return rankCitations(row.hits, query);
}

describe("eval queries with k omitted", () => {
	for (const spec of EVAL_QUERIES) {
		it(spec.id, () => {
			const ranked = rankedFor(spec.id, spec.query);
			expect(ranked.length).toBeGreaterThan(0);
			expect(ranked.length).toBeLessThanOrEqual(50);
			expect(ranked.every((hit) => hit.score >= MIN_SEARCH_SCORE)).toBe(true);
			if (spec.minSystems !== undefined) {
				expect(new Set(ranked.map((hit) => hit.system)).size).toBeGreaterThanOrEqual(spec.minSystems);
			}
			if (spec.noReferenceInTop !== undefined) {
				expect(
					ranked.slice(0, spec.noReferenceInTop).every((hit) => !isReferencePage(hit.url, hit.passage)),
				).toBe(true);
			}
			if (spec.firstSystem !== undefined) {
				expect(ranked[0]?.system).toBe(spec.firstSystem);
			}
			if (spec.firstUrl !== undefined) {
				expect(ranked[0]?.url).toBe(spec.firstUrl);
			}
		});
	}

	it("keeps the toast query at the measured one-system result instead of lowering 0.6", () => {
		const ranked = rankedFor("q02-toast-alert", "when should I use a toast vs an inline alert");
		expect([...new Set(ranked.map((hit) => hit.system))]).toEqual(["patternfly"]);
		const raw = measured.get("q02-toast-alert")?.hits ?? [];
		const paste = Math.max(...raw.filter((hit) => hit.system === "paste").map((hit) => hit.score));
		expect(paste).toBeLessThan(MIN_SEARCH_SCORE);
	});
});

describe("nonsense queries", () => {
	it("reports their reranker scores and does not fail when a result is returned", () => {
		const report = NONSENSE_QUERIES.map((spec) => {
			const row = measured.get(spec.id);
			if (!row) {
				throw new Error(`missing measured candidates for ${spec.id}`);
			}
			const ranked = rankCitations(row.hits, spec.query);
			return {
				id: spec.id,
				returned: ranked.length,
				max: Math.max(...row.hits.map((hit) => hit.score)),
			};
		});
		expect(report.map((row) => row.id)).toEqual(["q11-gibberish", "q12-banana"]);
		expect(report.every((row) => Number.isFinite(row.max))).toBe(true);
		expect(report.every((row) => row.returned === 0)).toBe(true);
	});
});

function paraphrase(partial: Partial<Citation> & Pick<Citation, "url" | "score" | "system" | "source">): Citation {
	return {
		passage: partial.passage ?? "guidance",
		source: partial.source,
		url: partial.url,
		system: partial.system,
		score: partial.score,
	};
}

describe("held-out common-word paraphrases", () => {
	it("does not boost Paste, Garden, Vanilla, or Ant Design for an ordinary use of the word", () => {
		const primer = paraphrase({
			url: "https://primer.style/product/components/text-input",
			score: 0.85,
			system: "primer",
			source: "Primer",
			passage: "A text input accepts typed text.",
		});
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://paste-dsys.com/components/input",
						score: 0.7,
						system: "paste",
						source: "Paste",
					}),
					primer,
				],
				"how do I paste text into an input",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://garden.zendesk.com/components/grid",
						score: 0.7,
						system: "garden",
						source: "Zendesk Garden",
					}),
					paraphrase({
						url: "https://cloudscape.design/components/grid",
						score: 0.85,
						system: "cloudscape",
						source: "Cloudscape",
					}),
				],
				"garden layout patterns",
			)[0]?.system,
		).toBe("cloudscape");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://vanillaframework.io/docs/patterns/forms",
						score: 0.7,
						system: "vanilla",
						source: "Vanilla Framework",
					}),
					primer,
				],
				"vanilla javascript form validation",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://ant.design/components/table",
						score: 0.7,
						system: "antd",
						source: "Ant Design",
					}),
					primer,
				],
				"ant colony",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://web.unified-design-system.orange.com/orange/docs/components/button",
						score: 0.7,
						system: "ouds-web",
						source: "OUDS Web",
					}),
					primer,
				],
				"orange juice",
			)[0]?.system,
		).toBe("primer");
	});

	it("names a system when punctuation sits around the name", () => {
		const other = paraphrase({
			url: "https://www.patternfly.org/components/button",
			score: 0.99,
			system: "patternfly",
			source: "PatternFly",
		});
		const paste = paraphrase({
			url: "https://paste-dsys.com/components/button",
			score: 0.7,
			system: "paste",
			source: "Paste",
		});
		const govuk = paraphrase({
			url: "https://design-system.service.gov.uk/components/button",
			score: 0.7,
			system: "govuk",
			source: "GOV.UK Design System",
		});
		for (const query of [
			"button guidance from Paste.",
			"button guidance from Paste!",
			"button guidance from Paste?",
			"button guidance from (Paste)",
			"button guidance from Paste,",
			'button guidance from "Paste"',
			"error summary from GOV.UK.",
		]) {
			const named = query.includes("GOV.UK") ? govuk : paste;
			expect(rankCitations([other, named], query)[0]?.system, query).toBe(named.system);
		}
	});

	it("keeps a distinctive name beside a determiner and still drops an ordinary use", () => {
		const other = paraphrase({
			url: "https://www.patternfly.org/components/table",
			score: 0.99,
			system: "patternfly",
			source: "PatternFly",
		});
		expect(
			rankCitations(
				[
					other,
					paraphrase({
						url: "https://cloudscape.design/components/table/",
						score: 0.7,
						system: "cloudscape",
						source: "Cloudscape",
					}),
				],
				"the Cloudscape table guidance",
			)[0]?.system,
		).toBe("cloudscape");
		expect(
			rankCitations(
				[
					other,
					paraphrase({
						url: "https://primer.style/product/components/button",
						score: 0.7,
						system: "primer",
						source: "Primer",
					}),
				],
				"a Primer button",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://paste-dsys.com/components/input",
						score: 0.7,
						system: "paste",
						source: "Paste",
					}),
					paraphrase({
						url: "https://primer.style/product/components/text-input",
						score: 0.85,
						system: "primer",
						source: "Primer",
					}),
				],
				"Paste the text into an input",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://primer.style/product/ui-patterns/forms",
						score: 0.7,
						system: "primer",
						source: "Primer",
					}),
					paraphrase({
						url: "https://cloudscape.design/patterns/general/errors/validation/",
						score: 0.85,
						system: "cloudscape",
						source: "Cloudscape",
					}),
				],
				"a primer on form validation",
			)[0]?.system,
		).toBe("cloudscape");
	});

	it("does not name a system from a determiner phrase", () => {
		const primer = paraphrase({
			url: "https://primer.style/product/components/text-input",
			score: 0.85,
			system: "primer",
			source: "Primer",
			passage: "A text input accepts typed text.",
		});
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://paste-dsys.com/components/input",
						score: 0.7,
						system: "paste",
						source: "Paste",
					}),
					primer,
				],
				"Paste the text into an input",
			)[0]?.system,
		).toBe("primer");
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://primer.style/product/ui-patterns/forms",
						score: 0.7,
						system: "primer",
						source: "Primer",
					}),
					paraphrase({
						url: "https://cloudscape.design/patterns/general/errors/validation/",
						score: 0.85,
						system: "cloudscape",
						source: "Cloudscape",
					}),
				],
				"a primer on form validation",
			)[0]?.system,
		).toBe("cloudscape");
	});

	it("boosts an unambiguous system name and keeps the button page first", () => {
		const wizard = paraphrase({
			url: "https://paste-dsys.com/page-templates/wizard",
			score: 0.98,
			system: "paste",
			source: "Paste",
			passage: "The wizard includes a Button.",
		});
		const button = paraphrase({
			url: "https://paste-dsys.com/components/button",
			score: 0.77,
			system: "paste",
			source: "Paste",
			passage: "Buttons show the actions available on a page.",
		});
		const foreign = paraphrase({
			url: "https://www.patternfly.org/components/button",
			score: 0.99,
			system: "patternfly",
			source: "PatternFly",
		});
		expect(rankCitations([foreign, wizard, button], "Paste buttons guidance").map((item) => item.url)).toEqual([
			button.url,
			wizard.url,
			foreign.url,
		]);
		expect(
			rankCitations(
				[
					paraphrase({
						url: "https://www.patternfly.org/components/table",
						score: 0.95,
						system: "patternfly",
						source: "PatternFly",
					}),
					paraphrase({
						url: "https://ant.design/components/table",
						score: 0.7,
						system: "antd",
						source: "Ant Design",
						passage: "A table displays rows of data.",
					}),
				],
				"ant design table",
			)[0]?.system,
		).toBe("antd");
		expect(
			rankCitations(
				[
					foreign,
					paraphrase({
						url: "https://paste-dsys.com/components/button",
						score: 0.7,
						system: "paste",
						source: "Paste",
					}),
				],
				"twilio paste button guidance",
			)[0]?.system,
		).toBe("paste");
		expect(
			rankCitations(
				[
					foreign,
					paraphrase({
						url: "https://ix.siemens.io/docs/components/button/guide",
						score: 0.7,
						system: "siemens-ix",
						source: "Siemens iX",
					}),
				],
				"ix button guidance",
			)[0]?.system,
		).toBe("siemens-ix");
		expect(
			rankCitations(
				[
					foreign,
					paraphrase({
						url: "https://web.unified-design-system.orange.com/orange/docs/components/button",
						score: 0.7,
						system: "ouds-web",
						source: "OUDS Web",
					}),
				],
				"Orange component guidance",
			)[0]?.system,
		).toBe("ouds-web");
	});
});
