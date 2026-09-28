import { isSystemId, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { liveSystemIds, readParks } from "./parks.ts";

export const RETRIEVAL_HOLD_KEY = "retrievalHold";

export type RetrievalHoldRead = { kind: "ok"; systems: Set<SystemId> } | { kind: "unread" };

export async function readRetrievalHold(env: WorkerEnv): Promise<RetrievalHoldRead> {
	if (!env.INDEX) {
		return { kind: "ok", systems: new Set() };
	}
	try {
		const raw = await env.INDEX.get(RETRIEVAL_HOLD_KEY);
		if (!raw) {
			return { kind: "ok", systems: new Set() };
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !isSystemId(id))) {
			return { kind: "unread" };
		}
		return { kind: "ok", systems: new Set(parsed) };
	} catch {
		return { kind: "unread" };
	}
}

async function writeHold(env: WorkerEnv, systems: Set<SystemId>): Promise<void> {
	if (!env.INDEX) {
		return;
	}
	await env.INDEX.put(RETRIEVAL_HOLD_KEY, JSON.stringify([...systems]));
}

export async function holdRetrieval(env: WorkerEnv, system: SystemId): Promise<void> {
	const read = await readRetrievalHold(env);
	if (read.kind === "unread") {
		return;
	}
	read.systems.add(system);
	await writeHold(env, read.systems);
}

export async function clearRetrievalHold(env: WorkerEnv, system: SystemId): Promise<void> {
	const read = await readRetrievalHold(env);
	if (read.kind === "unread" || !read.systems.has(system)) {
		return;
	}
	read.systems.delete(system);
	await writeHold(env, read.systems);
}

export async function liveSet(env: WorkerEnv): Promise<Set<SystemId> | null> {
	const parksRead = await readParks(env);
	const held = await readRetrievalHold(env);
	if (parksRead.kind === "unread" || held.kind === "unread") {
		return null;
	}
	return new Set(liveSystemIds(parksRead.parks).filter((id) => !held.systems.has(id)));
}
