import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Citation } from "../src/config/types.ts";
import { MIN_SEARCH_SCORE } from "../src/config/instance.ts";
import { isReferencePage, rankCitations } from "../src/serve/rank-citations.ts";
import candidates from "./fixtures/probe-candidates.json";
import { PROBE_QUERIES } from "./fixtures/probe-queries.ts";

type CandidateFile = {
	id: string;
	query: string;
	hits: Citation[];
};

const measured = new Map((candidates as CandidateFile[]).map((row) => [row.id, row]));

describe("held-out queries and paraphrases", () => {
	for (const spec of PROBE_QUERIES) {
		it(spec.id, () => {
			const row = measured.get(spec.id);
			if (!row) {
				throw new Error(`missing measured candidates for ${spec.id}`);
			}
			expect(row.query).toBe(spec.query);
			const ranked = rankCitations(row.hits, spec.query);
			expect(ranked.length).toBeGreaterThan(0);
			expect(ranked.filter((hit) => hit.score < MIN_SEARCH_SCORE).map((hit) => hit.url)).toEqual([]);
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
			if (spec.absentUrl !== undefined) {
				expect(ranked.some((hit) => hit.url === spec.absentUrl)).toBe(false);
			}
		});
	}

	it("records the Paste button page at 0.458 and does not return it", () => {
		const row = measured.get("p-paste-buttons");
		if (!row) {
			throw new Error("missing measured candidates for p-paste-buttons");
		}
		const ranked = rankCitations(row.hits, row.query);
		expect(ranked.filter((hit) => hit.score < MIN_SEARCH_SCORE).map((hit) => hit.url)).toEqual([]);
		expect(ranked.every((hit) => hit.score >= MIN_SEARCH_SCORE)).toBe(true);
		const button = Math.max(
			...row.hits
				.filter((hit) => hit.url.replace(/\/$/, "") === "https://paste-dsys.com/components/button")
				.map((hit) => hit.score),
		);
		expect(button).toBeCloseTo(0.458, 3);
		expect(button).toBeLessThan(MIN_SEARCH_SCORE);
		expect(ranked.some((hit) => hit.url.replace(/\/$/, "") === "https://paste-dsys.com/components/button")).toBe(false);
	});

	it("does not keep a hand-written query word list", () => {
		const source = readFileSync("src/serve/rank-citations.ts", "utf8");
		expect(source).not.toMatch(/STOP_WORDS/);
		expect(source).not.toMatch(/displaying|patterns|confirm/);
	});
});
