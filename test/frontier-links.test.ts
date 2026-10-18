import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { frontierLinks } from "../src/crawl/links.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";

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

	it("does not store static assets or pick them as a follow-up start", async () => {
		const markdown = [
			`See [logo](${ASSETS[0]})`,
			ASSETS[1],
			ASSETS[2],
			ASSETS[3],
			ASSETS[4],
			`[button](${PAGE})`,
			`[form](${HTML_PAGE})`,
		].join(" ");
		const links = frontierLinks(markdown, "https://paste-dsys.com/components/alert", seedById("paste"));
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		await pageQueue.addFrontier("paste", links);
		const stored = await db
			.prepare("SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url ASC")
			.bind("paste")
			.all<{ url: string }>();
		expect(stored.results?.map((row) => row.url)).toEqual([PAGE, HTML_PAGE]);
		for (const asset of ASSETS) {
			await db
				.prepare("INSERT INTO discover_frontier (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING")
				.bind("paste", asset)
				.run();
		}
		expect(await pageQueue.nextFrontier("paste", new Set())).toBe(PAGE);
	});
});
