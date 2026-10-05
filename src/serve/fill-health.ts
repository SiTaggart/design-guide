import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { isDue } from "../index/page-queue.ts";
import type { IndexStatusDocument } from "../index/status.ts";
import { readIndexOverlay } from "./index-status.ts";
import { systemPhase, type SystemPhase } from "./status-page.ts";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

export type FillHealthBody = {
	fill: "ok" | "alarm";
	alarms: string[];
	checkedAt: string;
};

type SeedView = {
	system: SystemId;
	parked: boolean;
	phase: SystemPhase;
	pending: number;
	claimed: number;
	failed: number;
	done: number;
	lastIndexed: string | null;
	lastDiscovered: string | null;
	error?: string;
};

export function fillHealthFrom(document: IndexStatusDocument, checkedAt: string): FillHealthBody {
	const alarms = fillAlarms(document, Date.parse(checkedAt));
	return {
		fill: alarms.length === 0 ? "ok" : "alarm",
		alarms,
		checkedAt,
	};
}

export async function handleFillHealth(env: WorkerEnv): Promise<Response> {
	const checkedAt = new Date().toISOString();
	const document = await readIndexOverlay(env);
	return new Response(JSON.stringify(fillHealthFrom(document, checkedAt)), {
		status: 200,
		headers: JSON_HEADERS,
	});
}

function fillAlarms(document: IndexStatusDocument, now: number): string[] {
	const seeds = seedViews(document);
	const alarms: string[] = [];
	const idle = document.queue.pending + document.queue.claimed === 0;
	if (document.discover === null && idle && seeds.some((seed) => emptyOrDue(seed, now))) {
		alarms.push("fleet_freeze");
	}
	for (const seed of seeds) {
		if (!seed.parked && seed.failed > 0 && seed.pending + seed.claimed === 0) {
			alarms.push(`stuck:${seed.system}`);
		}
	}
	if (seeds.some((seed) => seed.claimed > 0)) {
		for (const seed of seeds) {
			if (
				!seed.parked &&
				seed.phase === "mid-fill" &&
				seed.pending > 0 &&
				seed.claimed === 0 &&
				seed.done === 0
			) {
				alarms.push(`pending_no_claims:${seed.system}`);
			}
		}
	}
	if (hardFail(document, seeds)) {
		alarms.push("hard_fail");
	}
	return alarms;
}

function seedViews(document: IndexStatusDocument): SeedView[] {
	const freshness = new Map(document.freshness.map((row) => [row.system, row]));
	const errors = new Map<SystemId, string>();
	for (const entry of document.systems) {
		if (entry.error) {
			errors.set(entry.system, entry.error);
		}
	}
	return SYSTEM_IDS.map((system) => {
		const row = freshness.get(system);
		const parked = document.parks[system] !== undefined;
		const pending = Number(row?.pending ?? 0);
		const claimed = Number(row?.claimed ?? 0);
		const failed = Number(row?.failed ?? 0);
		const done = Number(row?.done ?? 0);
		const lastCrawled = row?.lastCrawled ?? null;
		const lastIndexed = row?.lastIndexed ?? null;
		const lastDiscovered = row?.lastDiscovered ?? null;
		const error = errors.get(system);
		return {
			system,
			parked,
			phase: systemPhase({
				parked,
				pending,
				claimed,
				failed,
				done,
				lastCrawled,
				lastIndexed,
				lastDiscovered,
				error,
			}),
			pending,
			claimed,
			failed,
			done,
			lastIndexed,
			lastDiscovered,
			error,
		};
	});
}

function emptyOrDue(seed: SeedView, now: number): boolean {
	if (seed.parked) {
		return false;
	}
	if (seed.phase === "empty") {
		return true;
	}
	return isDue({
		lastIndexed: seed.lastIndexed,
		lastDiscovered: seed.lastDiscovered,
		pending: seed.pending + seed.claimed,
		now,
	});
}

function hardFail(document: IndexStatusDocument, seeds: readonly SeedView[]): boolean {
	if (document.state === "fail" || document.runError) {
		return true;
	}
	return seeds.some((seed) => !seed.parked && seed.error !== undefined && seed.pending + seed.claimed === 0);
}
