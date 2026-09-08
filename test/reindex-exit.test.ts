import { describe, expect, it } from "vitest";
import type { SystemId } from "../src/config/types.ts";
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

describe("fitsItem", () => {
	const spectrum = seedById("react-spectrum");
	const primer = seedById("primer");
	const page = (url: string) => ({ url, status: "completed", markdown: "# docs" });

	it("indexes only md and mdx urls for react-spectrum", () => {
		expect(fitsItem(page("https://github.com/adobe/react-spectrum/blob/main/packages/dev/s2-docs/pages/index.mdx"), spectrum)).toBe(
			true,
		);
		expect(fitsItem(page("https://raw.githubusercontent.com/adobe/react-spectrum/main/packages/dev/s2-docs/pages/s2/ComboBox.md"), spectrum)).toBe(
			true,
		);
		expect(fitsItem(page("https://github.com/adobe/react-spectrum/blob/main/packages/dev/s2-docs/pages/WelcomeHeader.tsx"), spectrum)).toBe(
			false,
		);
	});

	it("does not apply suffix filters to other seeds", () => {
		expect(fitsItem(page("https://primer.style/components/button"), primer)).toBe(true);
	});
});
