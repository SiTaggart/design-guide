import { describe, expect, it } from "vitest";
import { SEEDS } from "../src/config/seed.ts";
import { seedById } from "../src/config/seed.ts";
import { SEED_HASH, catalogHash, crawlBounds, systemSeedHash } from "../src/index/seed-hash.ts";

describe("seed hashes", () => {
	it("is stable for the current catalog and per-seed payload", () => {
		expect(catalogHash()).toBe(SEED_HASH);
		expect(catalogHash(SEEDS)).toBe(SEED_HASH);
		expect(systemSeedHash(seedById("primer"))).toMatch(/^[a-f0-9]{64}$/);
		expect(systemSeedHash(seedById("primer"))).toBe(systemSeedHash(seedById("primer")));
		expect(systemSeedHash(seedById("primer"))).not.toBe(systemSeedHash(seedById("govuk")));
	});

	it("changes the per-seed hash when the crawl bounds change", () => {
		const primer = seedById("primer");
		const bounds = crawlBounds();
		expect(systemSeedHash(primer, { ...bounds, runawayPages: bounds.runawayPages - 1 })).not.toBe(
			systemSeedHash(primer, bounds),
		);
	});

	it("changes the per-seed hash when source is renamed", () => {
		const primer = seedById("primer");
		const renamed = systemSeedHash({ ...primer, source: "Primer Renamed" });
		expect(renamed).not.toBe(systemSeedHash(primer));
	});
});
