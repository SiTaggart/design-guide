import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { LAST_INDEXED_HASH_KEY } from "./status.ts";
import { SEED_HASH, allSeedHashesMatch, seedHashKey } from "./seed-hash.ts";

export async function readIndexedHashes(env: WorkerEnv): Promise<Record<string, string>> {
	const indexed: Record<string, string> = {};
	if (!env.INDEX) {
		return indexed;
	}
	for (const id of SYSTEM_IDS) {
		const hash = await env.INDEX.get(seedHashKey(id));
		if (hash) {
			indexed[id] = hash;
		}
	}
	return indexed;
}

export async function writeIndexedHash(env: WorkerEnv, system: SystemId, hash: string): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	await env.INDEX.put(seedHashKey(system), hash);
}

export async function writeLastIndexedHashIfComplete(env: WorkerEnv): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	const indexed = await readIndexedHashes(env);
	if (!allSeedHashesMatch(indexed)) {
		return;
	}
	await env.INDEX.put(LAST_INDEXED_HASH_KEY, SEED_HASH);
}
