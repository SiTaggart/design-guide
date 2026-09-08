import { describe, expect, it } from "vitest";
import type { SystemId } from "../src/config/types.ts";
import { reindexExitCode, type SystemReindexResult } from "../src/index/reindex.ts";

function result(system: SystemId, indexed: number, hitLimit = false): SystemReindexResult {
	return {
		system,
		startUrl: `https://${system}.test/`,
		crawl: { total: indexed, finished: indexed, skipped: 0, disallowed: 0, errored: 0 },
		indexed,
		hitLimit,
		keptPrevious: indexed === 0,
	};
}

describe("reindexExitCode", () => {
	it("fails when any system hit the crawl limit", () => {
		expect(reindexExitCode([result("primer", 900), result("govuk", 0, true)])).toBe(1);
	});

	it("fails when every web system kept its previous generation", () => {
		expect(reindexExitCode([result("primer", 0), result("govuk", 0), result("carbon", 0)])).toBe(1);
		expect(reindexExitCode([result("primer", 0)])).toBe(1);
	});

	it("allows carbon to miss while a web system indexed", () => {
		expect(reindexExitCode([result("primer", 900), result("carbon", 0)])).toBe(0);
	});

	it("allows a carbon-only run to miss", () => {
		expect(reindexExitCode([result("carbon", 0)])).toBe(0);
	});
});
