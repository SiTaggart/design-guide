import { describe, expect, it } from "vitest";
import type { Seed } from "../src/config/types.ts";
import { seedById } from "../src/config/seed.ts";
import { linkAllowed } from "../src/crawl/links.ts";

const ouds = seedById("ouds-web");
const root = "https://web.unified-design-system.orange.com/orange/";

const docsInclude: Seed = {
	id: "siemens-ix",
	source: "fixture",
	startUrl: "https://example.test/docs/home",
	includePatterns: ["https://example.test/docs/**"],
};

describe("linkAllowed", () => {
	it("rejects a /** exclude prefix and keeps longer siblings", () => {
		expect(linkAllowed(`${root}docs/0.4`, ouds)).toBe(false);
		expect(linkAllowed(`${root}docs/0.4/`, ouds)).toBe(false);
		expect(linkAllowed(`${root}docs/0.4/page`, ouds)).toBe(false);
		expect(linkAllowed(`${root}docs/0.40`, ouds)).toBe(true);
		expect(linkAllowed(`${root}docs/0.4x`, ouds)).toBe(true);
	});

	it("keeps /** includes on their main answers", () => {
		expect(linkAllowed("https://web.unified-design-system.orange.com/orange", ouds)).toBe(true);
		expect(linkAllowed(`${root}docs/1.5`, ouds)).toBe(true);
		expect(linkAllowed("https://ix.siemens.io/docs", seedById("siemens-ix"))).toBe(false);
		expect(linkAllowed("https://ix.siemens.io/docs/home", seedById("siemens-ix"))).toBe(true);
		expect(linkAllowed("https://www.skyscanner.design/latest", seedById("backpack"))).toBe(false);
	});

	it("does not admit the bare directory of an include that ends in /**", () => {
		expect(linkAllowed("https://example.test/docs", docsInclude)).toBe(false);
		expect(linkAllowed("https://example.test/docs/home", docsInclude)).toBe(true);
	});
});
