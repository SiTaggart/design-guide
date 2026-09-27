import { createHash } from "node:crypto";
import { SEEDS } from "../config/seed.ts";
import { SYSTEM_IDS, type Seed, type SystemId } from "../config/types.ts";

export function seedHashKey(id: SystemId): string {
	return `seedHash/${id}`;
}

export function systemSeedHash(seed: Seed): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				id: seed.id,
				source: seed.source,
				startUrl: seed.startUrl,
				fallbackStartUrl: seed.fallbackStartUrl ?? null,
				includePatterns: seed.includePatterns ?? null,
				excludePatterns: seed.excludePatterns ?? null,
				indexUrlSuffixes: seed.indexUrlSuffixes ?? null,
				render: seed.render ?? true,
				includeSubdomains: seed.includeSubdomains ?? false,
			}),
		)
		.digest("hex");
}

export function catalogHash(seeds: readonly Seed[] = SEEDS): string {
	const hashes = [...seeds]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((seed) => systemSeedHash(seed));
	return createHash("sha256").update(hashes.join("")).digest("hex");
}

export const SEED_HASH = catalogHash();

export function driftedSystems(
	indexed: Readonly<Record<string, string>>,
	seeds: readonly Seed[] = SEEDS,
): SystemId[] {
	return seeds.filter((seed) => indexed[seed.id] !== systemSeedHash(seed)).map((seed) => seed.id);
}

export function allSeedHashesMatch(
	indexed: Readonly<Record<string, string>>,
	seeds: readonly Seed[] = SEEDS,
): boolean {
	if (SYSTEM_IDS.some((id) => seeds.find((seed) => seed.id === id) === undefined)) {
		return false;
	}
	return seeds.length === SYSTEM_IDS.length && driftedSystems(indexed, seeds).length === 0;
}
