import { describe, expect, it } from "vitest";
import type { Seed, SystemId } from "../src/config/types.ts";
import { fitsItem, reindexExitCode, type SystemReindexResult } from "../src/index/reindex.ts";
import { seedById } from "../src/config/seed.ts";

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

	it("fails when every system kept its previous generation", () => {
		expect(reindexExitCode([result("primer", 0), result("govuk", 0)])).toBe(1);
		expect(reindexExitCode([result("primer", 0)])).toBe(1);
	});

	it("succeeds when at least one system indexed", () => {
		expect(reindexExitCode([result("primer", 900), result("govuk", 0)])).toBe(0);
	});
});

describe("fitsItem", () => {
	const filtered: Seed = { ...seedById("primer"), indexUrlSuffixes: [".md", ".mdx"] };
	const primer = seedById("primer");
	const page = (url: string) => ({ url, status: "completed", markdown: "# docs" });

	it("indexes only md and mdx urls when a seed sets indexUrlSuffixes", () => {
		expect(fitsItem(page("https://primer.style/index.mdx"), filtered)).toBe(true);
		expect(fitsItem(page("https://primer.style/ComboBox.md"), filtered)).toBe(true);
		expect(fitsItem(page("https://primer.style/WelcomeHeader.tsx"), filtered)).toBe(false);
	});

	it("does not apply suffix filters to other seeds", () => {
		expect(fitsItem(page("https://primer.style/components/button"), primer)).toBe(true);
	});
});
