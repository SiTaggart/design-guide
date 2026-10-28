import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { frontierLinks } from "../src/crawl/links.ts";

const PAGE = "https://paste-dsys.com/components/button";
const HTML_PAGE = "https://paste-dsys.com/patterns/form.html";
const ASSETS = [
	"https://paste-dsys.com/_next/static/media/logo.svg",
	"https://paste-dsys.com/images/icon.png",
	"https://paste-dsys.com/fonts/inter.woff2",
	"https://paste-dsys.com/styles/app.css",
	"https://paste-dsys.com/scripts/app.js",
];

describe("frontierLinks", () => {
	it("leaves llms.txt index files off the frontier", () => {
		const links = frontierLinks(
			"See [index](https://cloudscape.design/llms.txt) and [full](https://cloudscape.design/llms-full.txt) and [table](https://cloudscape.design/components/table/).",
			"https://cloudscape.design/",
			seedById("cloudscape"),
		);
		expect(links).toEqual(["https://cloudscape.design/components/table"]);
	});

	it("does not start a crawl per query-string variant of the same path", () => {
		const links = frontierLinks(
			"See https://cloudscape.design/components/table?tabId=1 and https://cloudscape.design/components/table?tabId=2 and [alert](https://cloudscape.design/components/alert).",
			"https://cloudscape.design/components/table",
			seedById("cloudscape"),
		);
		expect(links).toEqual([
			"https://cloudscape.design/components/table",
			"https://cloudscape.design/components/alert",
		]);
	});

	it("does not pick a query-string variant when the path was already linked", () => {
		const links = frontierLinks(
			"See https://cloudscape.design/components/alert?tabId=1 and https://cloudscape.design/components/table",
			"https://cloudscape.design/components/alert",
			seedById("cloudscape"),
		);
		expect(links).toEqual([
			"https://cloudscape.design/components/alert",
			"https://cloudscape.design/components/table",
		]);
	});

	it("leaves static assets out of the links", () => {
		const markdown = [
			`See [logo](${ASSETS[0]})`,
			ASSETS[1],
			ASSETS[2],
			ASSETS[3],
			ASSETS[4],
			`[button](${PAGE})`,
			`[form](${HTML_PAGE})`,
		].join(" ");
		expect(frontierLinks(markdown, "https://paste-dsys.com/components/alert", seedById("paste"))).toEqual([
			PAGE,
			HTML_PAGE,
		]);
	});
});
