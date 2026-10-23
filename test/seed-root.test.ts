import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { admittedUrl, canonicalLink } from "../src/crawl/links.ts";

const HOME = "https://web.unified-design-system.orange.com/orange";
const CHILD = "https://web.unified-design-system.orange.com/orange/docs/1.5/page";
const OLDER = "https://web.unified-design-system.orange.com/orange/docs/0.4/page";
const NEAR = "https://web.unified-design-system.orange.com/orange-extra";

describe("seed root admission", () => {
	it("admits the configured root with or without a trailing slash", () => {
		const seed = seedById("ouds-web");
		expect(admittedUrl(`${HOME}/`, seed)).toBe(HOME);
		expect(admittedUrl(HOME, seed)).toBe(HOME);
		expect(admittedUrl(`${CHILD}/`, seed)).toBe(CHILD);
		expect(admittedUrl(OLDER, seed)).toBeNull();
		expect(admittedUrl(NEAR, seed)).toBeNull();
	});

	it("still requires a slash after a /** prefix that is not the seed root", () => {
		const seed = seedById("siemens-ix");
		expect(admittedUrl("https://ix.siemens.io/docs", seed)).toBeNull();
		expect(admittedUrl("https://ix.siemens.io/docs/", seed)).toBeNull();
		expect(admittedUrl("https://ix.siemens.io/docs//", seed)).toBeNull();
		expect(admittedUrl("https://ix.siemens.io/docs/home/overview", seed)).toBe(
			"https://ix.siemens.io/docs/home/overview",
		);
	});

	it("strips a long trailing slash run and stays the same url", () => {
		const seed = seedById("backpack");
		const page = "https://www.skyscanner.design/latest/real";
		const admitted = admittedUrl(`${page}${"/".repeat(100_000)}`, seed);
		expect(admitted).toBe(page);
		expect(admittedUrl(admitted ?? "", seed)).toBe(admitted);
		expect(canonicalLink("https://example.test///", "https://example.test///")).toBe("https://example.test/");
	});

	it("returns the same url when admission runs again", () => {
		const seed = seedById("backpack");
		const page = "https://www.skyscanner.design/latest/real";
		for (const input of [page, `${page}/`, `${page}?view=1`, `${page}${"/".repeat(16)}`]) {
			const admitted = admittedUrl(input, seed);
			expect(admitted).toBe(page);
			expect(admittedUrl(admitted ?? "", seed)).toBe(admitted);
		}
	});
});
