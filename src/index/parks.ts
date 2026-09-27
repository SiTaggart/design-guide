import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";

export const PARKS_KEY = "parks";

export type ParkRecord = {
	reason: "stub";
	usable: number;
	at: string;
};

export type Parks = Partial<Record<SystemId, ParkRecord>>;

export type ParksRead = { kind: "ok"; parks: Parks } | { kind: "unread" };

export function liveSystemIds(parks: Parks): SystemId[] {
	return SYSTEM_IDS.filter((id) => parks[id] === undefined);
}

export function parkedSystemIds(parks: Parks): SystemId[] {
	return SYSTEM_IDS.filter((id) => parks[id] !== undefined);
}

export async function readParks(env: WorkerEnv): Promise<ParksRead> {
	if (!env.INDEX) {
		return { kind: "ok", parks: {} };
	}
	try {
		const raw = await env.INDEX.get(PARKS_KEY);
		if (!raw) {
			return { kind: "ok", parks: {} };
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { kind: "unread" };
		}
		return { kind: "ok", parks: parsed as Parks };
	} catch {
		return { kind: "unread" };
	}
}

export async function loadLiveSystemIds(env: WorkerEnv): Promise<Set<SystemId>> {
	const read = await readParks(env);
	if (read.kind === "unread") {
		throw new Error("parks unread");
	}
	return new Set(liveSystemIds(read.parks));
}

export async function writePark(
	env: WorkerEnv,
	system: SystemId,
	usable: number,
	at = new Date().toISOString(),
): Promise<ParkRecord> {
	const record: ParkRecord = { reason: "stub", usable, at };
	const read = await readParks(env);
	if (read.kind === "unread" || !env.INDEX) {
		return record;
	}
	read.parks[system] = record;
	await env.INDEX.put(PARKS_KEY, JSON.stringify(read.parks));
	return record;
}

export async function clearPark(env: WorkerEnv, system: SystemId): Promise<void> {
	const read = await readParks(env);
	if (read.kind === "unread" || read.parks[system] === undefined || !env.INDEX) {
		return;
	}
	delete read.parks[system];
	await env.INDEX.put(PARKS_KEY, JSON.stringify(read.parks));
}
