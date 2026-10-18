import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { frontierLinks } from "../src/crawl/links.ts";

describe("frontierLinks", () => {
	it("leaves llms.txt index files off the frontier", () => {
		const links = frontierLinks(
			"See [index](https://cloudscape.design/llms.txt) and [full](https://cloudscape.design/llms-full.txt) and [table](https://cloudscape.design/components/table/).",
			"https://cloudscape.design/",
			seedById("cloudscape"),
		);
		expect(links).toEqual(["https://cloudscape.design/components/table"]);
	});
});
