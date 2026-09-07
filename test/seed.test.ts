import { describe, expect, it } from "vitest";
import { SEEDS } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";

describe("seed registry", () => {
	it("lists all nine locked systems and no others", () => {
		expect(SEEDS.map((seed) => seed.id)).toEqual([...SYSTEM_IDS]);
		expect(SEEDS).toHaveLength(9);
	});

	it("keeps carbon on GitHub and react-spectrum off spectrum.adobe.com", () => {
		const carbon = SEEDS.find((seed) => seed.id === "carbon");
		const spectrum = SEEDS.find((seed) => seed.id === "react-spectrum");
		expect(carbon?.startUrls.every((url) => url.includes("github.com") || url.includes("raw.githubusercontent.com"))).toBe(
			true,
		);
		expect(spectrum?.startUrls.every((url) => url.startsWith("https://react-spectrum.adobe.com/"))).toBe(
			true,
		);
	});
});
