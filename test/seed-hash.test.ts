import { describe, expect, it } from "vitest";
import { SEEDS } from "../src/config/seed.ts";
import { seedById } from "../src/config/seed.ts";
import {
	SEED_HASH,
	catalogHash,
	driftedSystems,
	systemSeedHash,
} from "../src/index/seed-hash.ts";

describe("seed hashes", () => {
	it("is stable for the current catalog and per-seed payload", () => {
		expect(catalogHash()).toBe(SEED_HASH);
		expect(catalogHash(SEEDS)).toBe(SEED_HASH);
		expect(systemSeedHash(seedById("primer"))).toMatch(/^[a-f0-9]{64}$/);
		expect(systemSeedHash(seedById("primer"))).toBe(systemSeedHash(seedById("primer")));
		expect(systemSeedHash(seedById("primer"))).not.toBe(systemSeedHash(seedById("govuk")));
	});

	it("lists systems whose stored hash is missing or different", () => {
		const primer = systemSeedHash(seedById("primer"));
		const indexed = Object.fromEntries(SEEDS.map((seed) => [seed.id, systemSeedHash(seed)]));
		expect(driftedSystems(indexed)).toEqual([]);
		expect(driftedSystems({ ...indexed, primer: "changed" })).toEqual(["primer"]);
		const { primer: _drop, ...missing } = indexed;
		expect(driftedSystems(missing)).toEqual(["primer"]);
	});
});
