import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { frontierLinks, linkBase } from "../src/crawl/links.ts";

const DOCS = "https://vanillaframework.io/docs/";
const BUTTON = "https://vanillaframework.io/docs/components/button";
const PATTERN_PAGE = "https://vanillaframework.io/docs/patterns/form";
const GRID = "https://vanillaframework.io/docs/components/grid";

function links(system: "vanilla" | "siemens-ix" | "backpack", pageUrl: string, markdown: string): string[] {
	const seed = seedById(system);
	return frontierLinks(markdown, linkBase(pageUrl, markdown, seed), seed).sort();
}

describe("relative links use the fetched page", () => {
	it("resolves a relative link against the page url and a base href", () => {
		expect(links("vanilla", DOCS, "See [button](components/button).")).toEqual([BUTTON]);
		expect(links("vanilla", PATTERN_PAGE, '<base href="/docs/">\nSee [grid](components/grid).')).toEqual([GRID]);
	});

	it("keeps the directory slash on a base href", () => {
		const page = "https://ix.siemens.io/docs/home/overview";
		expect(links("siemens-ix", page, '<base href="/docs/">\nSee [button](components/button).')).toEqual([
			"https://ix.siemens.io/docs/components/button",
		]);
	});

	it("ignores a base tag inside a code block", () => {
		const fenced = ["```html", '<base href="/example/">', "```", "See [button](components/button)."].join("\n");
		const inline = "The tag `<base href=\"/example/\">` is sample markup. See [grid](components/grid).";
		expect(links("vanilla", DOCS, fenced)).toEqual([BUTTON]);
		expect(links("vanilla", PATTERN_PAGE, inline)).toEqual([
			"https://vanillaframework.io/docs/patterns/components/grid",
		]);
	});

	it("ignores a cross-origin or out-of-scope base", () => {
		expect(links("vanilla", DOCS, '<base href="https://primer.style/">\nSee [button](components/button).')).toEqual([
			BUTTON,
		]);
		expect(
			links(
				"backpack",
				"https://www.skyscanner.design/latest/real",
				'<base href="https://www.skyscanner.design/account/">\nSee [next](other).',
			),
		).toEqual(["https://www.skyscanner.design/latest/other"]);
	});
});
