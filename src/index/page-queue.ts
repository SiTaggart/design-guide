import { SYSTEM_IDS, isSystemId, type SystemId } from "../config/types.ts";
import { D1_STEP_RETRIES, d1MaxBackoffMs, d1Query, tickFrom, type D1QueryStep, type D1QueueOptions } from "./d1-step.ts";

export const DRAIN_LIMIT = 100;
export const MAX_ATTEMPTS = 5;
const FILL_LEASE_ID = "fill";

/**
 * A cron worker can run for 15 minutes. The fill lease used to expire at that same age, so a
 * slow tick could lose the lease while it was still writing. The queue stops starting D1 writes
 * and retry sleeps at tickDeadlineMs. maxBackoffMs is the longest sleep that can still start
 * before that deadline. marginMs is the room for one page operation already in flight. ttlMs
 * is that deadline plus the longest sleep, the margin, and slack, which is 255 seconds and
 * stays under the 5 minute cron. A release that never lands is taken over about one tick later.
 */
const FILL_TICK_DEADLINE = 3 * 60 * 1000;
const FILL_LEASE_MARGIN_MS = 30 * 1000;
const FILL_LEASE_SLACK_MS = 5 * 1000;

export const FILL_LEASE_WINDOW = {
	tickDeadlineMs: FILL_TICK_DEADLINE,
	maxBackoffMs: d1MaxBackoffMs(D1_STEP_RETRIES),
	marginMs: FILL_LEASE_MARGIN_MS,
	cronIntervalMs: 5 * 60 * 1000,
	ttlMs: FILL_TICK_DEADLINE + d1MaxBackoffMs(D1_STEP_RETRIES) + FILL_LEASE_MARGIN_MS + FILL_LEASE_SLACK_MS,
} as const;

export const FILL_TICK_DEADLINE_MS = FILL_LEASE_WINDOW.tickDeadlineMs;
export const FILL_LEASE_STALE_MS = FILL_LEASE_WINDOW.ttlMs;

export type QueueDepths = {
	pending: number;
	claimed: number;
	failed: number;
	done: number;
};

export type SystemFreshness = {
	system: SystemId;
	lastCrawled: string | null;
	lastIndexed: string | null;
	lastDiscovered: string | null;
	pending: number;
	claimed: number;
	failed: number;
	done: number;
};

export function emptyDepths(): QueueDepths {
	return { pending: 0, claimed: 0, failed: 0, done: 0 };
}

async function all<T>(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<T[]> {
	const result = await d1Query<{ results?: T[] }>(step, true, "all", sql, params);
	return result.results ?? [];
}

async function run(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<number> {
	const result = await d1Query<{ meta?: { changes?: number } }>(step, true, "run", sql, params);
	return result.meta?.changes ?? 0;
}

async function runBypass(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<number> {
	const result = await d1Query<{ meta?: { changes?: number } }>(step, false, "run", sql, params, true);
	return result.meta?.changes ?? 0;
}

export class D1PageQueue {
	private readonly step: D1QueryStep;

	constructor(db: D1Database, options?: D1QueueOptions) {
		this.step = { db, tick: tickFrom(options) };
	}

	async depths(): Promise<QueueDepths> {
		const rows = await all<{ status: string; n: number }>(
			this.step,
			"SELECT status, COUNT(*) AS n FROM page_work GROUP BY status",
		);
		const depths = emptyDepths();
		for (const row of rows) {
			if (row.status === "pending" || row.status === "claimed" || row.status === "failed" || row.status === "done") {
				depths[row.status] = Number(row.n);
			}
		}
		return depths;
	}

	async freshness(): Promise<SystemFreshness[]> {
		const rows = await all<{
			system_id: string;
			last_crawled: string | null;
			last_indexed: string | null;
			pending: number;
			claimed: number;
			failed: number;
			done: number;
		}>(
			this.step,
			`SELECT system_id,
			        MAX(last_crawled) AS last_crawled,
			        MAX(last_indexed) AS last_indexed,
			        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
			        SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
			        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
			        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
			 FROM page_work
			 GROUP BY system_id`,
		);
		const marks = await all<{ system_id: string; last_discovered: string | null }>(
			this.step,
			"SELECT system_id, last_discovered FROM system_mark",
		);
		const byId = new Map(rows.filter((row) => isSystemId(row.system_id)).map((row) => [row.system_id, row]));
		const discovered = new Map(
			marks.filter((row) => isSystemId(row.system_id)).map((row) => [row.system_id, row.last_discovered]),
		);
		return SYSTEM_IDS.map((system) => {
			const row = byId.get(system);
			return {
				system,
				lastCrawled: row?.last_crawled ?? null,
				lastIndexed: row?.last_indexed ?? null,
				lastDiscovered: discovered.get(system) ?? null,
				pending: Number(row?.pending ?? 0),
				claimed: Number(row?.claimed ?? 0),
				failed: Number(row?.failed ?? 0),
				done: Number(row?.done ?? 0),
			};
		});
	}

	async claimFillLease(owner: string, now: string): Promise<boolean> {
		const staleBefore = new Date(Date.parse(now) - FILL_LEASE_STALE_MS).toISOString();
		const changes = await run(
			this.step,
			`INSERT INTO fill_lease (id, owner, claimed_at) VALUES (?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   owner = excluded.owner,
			   claimed_at = excluded.claimed_at
			 WHERE fill_lease.owner = excluded.owner
			    OR fill_lease.claimed_at < ?`,
			FILL_LEASE_ID,
			owner,
			now,
			staleBefore,
		);
		return changes === 1;
	}

	async releaseFillLease(owner: string): Promise<void> {
		const changes = await runBypass(
			this.step,
			"DELETE FROM fill_lease WHERE id = ? AND owner = ?",
			FILL_LEASE_ID,
			owner,
		);
		if (changes === 0) {
			console.log(JSON.stringify({ event: "fill_lease_release_missed", owner }));
		}
	}
}
