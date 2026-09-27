import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";

export const PARKS_KEY = "parks";

export type ParkRecord = {
	reason: "stub";
	usable: number;
	at: string;
};

export type Parks = Partial<Record<SystemId, ParkRecord>>;

export function liveSystemIds(parks: Parks): SystemId[] {
	return SYSTEM_IDS.filter((id) => parks[id] === undefined);
}

export function parkedSystemIds(parks: Parks): SystemId[] {
	return SYSTEM_IDS.filter((id) => parks[id] !== undefined);
}

export async function readParks(env: WorkerEnv): Promise<Parks> {
	if (!env.INDEX) {
		return {};
	}
	try {
		const raw = await env.INDEX.get(PARKS_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as Parks;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export async function loadLiveSystemIds(env: WorkerEnv): Promise<Set<SystemId>> {
	return new Set(liveSystemIds(await readParks(env)));
}

export async function writePark(
	env: WorkerEnv,
	system: SystemId,
	usable: number,
	at = new Date().toISOString(),
): Promise<ParkRecord> {
	const parks = await readParks(env);
	const record: ParkRecord = { reason: "stub", usable, at };
	parks[system] = record;
	if (env.INDEX) {
		await env.INDEX.put(PARKS_KEY, JSON.stringify(parks));
	}
	return record;
}

export async function clearPark(env: WorkerEnv, system: SystemId): Promise<void> {
	const parks = await readParks(env);
	if (parks[system] === undefined) {
		return;
	}
	delete parks[system];
	if (env.INDEX) {
		await env.INDEX.put(PARKS_KEY, JSON.stringify(parks));
	}
}
