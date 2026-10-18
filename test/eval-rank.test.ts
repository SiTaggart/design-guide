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
			if (spec.firstUrl !== undefined) {
				expect(ranked[0]?.url).toBe(spec.firstUrl);
				expect(ranked[0]?.system).toBe("paste");
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
	});
});
