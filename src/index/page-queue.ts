import { seedById } from "../config/seed.ts";
import { SYSTEM_IDS, isSystemId, type SystemId } from "../config/types.ts";
import { admittedUrl, isStaticAsset, pageKey } from "../crawl/links.ts";
import { D1_STEP_RETRIES, d1MaxBackoffMs, d1Query, tickFrom, type D1QueryStep, type D1QueueOptions } from "./d1-step.ts";

export const DRAIN_LIMIT = 100;
export const MAX_ATTEMPTS = 5;
export const FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
/** Same hour as discover cap defer. A real exhausted failure waits this long, then claim() tries it again. */
export const EXHAUSTED_RETRY_MS = 60 * 60 * 1000;
const STALE_CLAIM_MS = 15 * 60 * 1000;
const FILL_LEASE_ID = "fill";
// Not a page url. A yielded slice that was capped or skipped leaves this row so a later full pass does not prune.
const INCOMPLETE_SLICE = "yield:incomplete";
// Slice progress on discover_run.error, which otherwise stays unused.
// slice:<0|1>:<frontier rows at slice start>. 1 means the slice accepted a url.
const SLICE_MARK = /^slice:([01]):(\d+)$/;

/**
 * A cron worker can run for 15 minutes. The fill lease used to expire at that same age, so a
 * slow tick could lose the lease while it was still writing. The queue stops starting D1 writes
 * and retry sleeps at tickDeadlineMs. maxBackoffMs is the longest sleep that can still start
 * before that deadline. marginMs is the room for one page operation already in flight. ttlMs
 * is that deadline plus the longest sleep, the margin, and slack, which is 255 seconds and
 * stays under the 5 minute cron. A release that never lands is taken over about one tick later.
 * Pages still claimed by this tick are handed back with one bypass write in that same final
 * path, before the lease delete, so the hand-back adds no retry sleep.
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
const CLAIM_EXPIRED = "claim expired";

export type PageKind = "seed" | "reindex";
export type PageStatus = "pending" | "claimed" | "failed" | "done";

export type PageWorkItem = {
	systemId: SystemId;
	url: string;
	kind: PageKind;
	enqueuedAt: string;
	attempts: number;
	lastCrawled?: string;
	lastIndexed?: string;
	status: PageStatus;
	itemKey: string | null;
	claimedAt?: string;
	claimToken?: string;
};

export type ClaimedPage = PageWorkItem & { claimedAt: string };

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

export type PageQueue = {
	enqueueUpsert(
		items: ReadonlyArray<{ systemId: SystemId; url: string; kind: PageKind }>,
		now: string,
		options?: { keepDone?: boolean },
	): Promise<void>;
	claim(limit: number, now: string): Promise<ClaimedPage[]>;
	complete(
		item: Pick<PageWorkItem, "systemId" | "url" | "claimToken"> & { attempts?: number; claimedAt?: string },
		timestamps: { lastCrawled: string; lastIndexed: string },
		itemKey: string | null,
		options?: { keepIndexedAt?: boolean },
	): Promise<boolean>;
	holdsFreshness(systemId: SystemId): Promise<boolean>;
	fail(
		item: Pick<PageWorkItem, "systemId" | "url" | "claimToken"> & { attempts?: number; claimedAt?: string },
		error: string,
	): Promise<boolean>;
	owns(item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt" | "claimToken">): Promise<boolean>;
	releaseForRetry(
		item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt" | "claimToken">,
		itemKey: string,
	): Promise<boolean>;
	depths(): Promise<QueueDepths>;
	listAbsent(
		systemId: SystemId,
		liveUrls: ReadonlySet<string>,
	): Promise<Array<{ url: string; itemKey: string | null }>>;
	removeUrls(systemId: SystemId, urls: readonly string[]): Promise<void>;
};

export type DiscoverRun = {
	systemId: SystemId;
	kind: PageKind;
	trigger: "deploy-drift" | "recrawl" | "recovery";
	jobId: string;
	startUrl: string;
	cursor: string | null;
	pollFailures: number;
	startedAt: string;
};

type WorkRow = {
	system_id: string;
	url: string;
	kind: string;
	status: string;
	enqueued_at: string;
	attempts: number;
	last_crawled: string | null;
	last_indexed: string | null;
	item_key: string | null;
};

type RunRow = {
	system_id: string;
	kind: string;
	trigger_name: string;
	job_id: string;
	start_url: string;
	cursor: string | null;
	poll_failures: number;
	started_at: string;
};

export function emptyDepths(): QueueDepths {
	return { pending: 0, claimed: 0, failed: 0, done: 0 };
}

function asKind(value: string): PageKind {
	return value === "seed" ? "seed" : "reindex";
}

function asTrigger(value: string): DiscoverRun["trigger"] {
	if (value === "deploy-drift" || value === "recovery") {
		return value;
	}
	return "recrawl";
}

function asStatus(value: string): PageStatus {
	if (value === "claimed" || value === "failed" || value === "done") {
		return value;
	}
	return "pending";
}

function toItem(row: WorkRow): PageWorkItem | null {
	if (!isSystemId(row.system_id)) {
		return null;
	}
	return {
		systemId: row.system_id,
		url: row.url,
		kind: asKind(row.kind),
		enqueuedAt: row.enqueued_at,
		attempts: Number(row.attempts),
		...(row.last_crawled ? { lastCrawled: row.last_crawled } : {}),
		...(row.last_indexed ? { lastIndexed: row.last_indexed } : {}),
		status: asStatus(row.status),
		itemKey: row.item_key,
	};
}

async function all<T>(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<T[]> {
	const result = await d1Query<{ results?: T[] }>(step, true, "all", sql, params);
	return result.results ?? [];
}

async function first<T>(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<T | null> {
	const row = await d1Query<T | null>(step, true, "first", sql, params);
	return row ?? null;
}

async function run(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<number> {
	const result = await d1Query<{ meta?: { changes?: number } }>(step, true, "run", sql, params);
	return result.meta?.changes ?? 0;
}

async function runOnce(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<number> {
	const result = await d1Query<{ meta?: { changes?: number } }>(step, false, "run", sql, params);
	return result.meta?.changes ?? 0;
}

async function runBypass(step: D1QueryStep, sql: string, ...params: unknown[]): Promise<number> {
	const result = await d1Query<{ meta?: { changes?: number } }>(step, false, "run", sql, params, true);
	return result.meta?.changes ?? 0;
}

type ClaimLanding = "done" | "failed" | "pending";

async function holderFinished(
	step: D1QueryStep,
	item: { systemId: string; url: string; claimToken?: string },
	landed: ClaimLanding,
): Promise<boolean> {
	if (!item.claimToken) {
		return false;
	}
	const row = await first<{ status: string; claim_token: string | null }>(
		step,
		"SELECT status, claim_token FROM page_work WHERE system_id = ? AND url = ?",
		item.systemId,
		item.url,
	);
	return row?.status === landed && row.claim_token === item.claimToken;
}

async function guardedChanges(
	step: D1QueryStep,
	op: string,
	item: { systemId: string; url: string; claimToken?: string },
	landed: ClaimLanding,
	changes: number,
): Promise<boolean> {
	const lost = changes !== 1 && !step.tick?.budget.deadline && !(await holderFinished(step, item, landed));
	if (lost) {
		console.log(JSON.stringify({ event: "page_claim_lost", op, system: item.systemId, url: item.url }));
	}
	return changes === 1;
}

export class D1PageQueue implements PageQueue {
	private readonly db: D1Database;
	private readonly step: D1QueryStep;

	constructor(db: D1Database, options?: D1QueueOptions) {
		this.db = db;
		this.step = { db, tick: tickFrom(options) };
	}

	async enqueueUpsert(
		items: ReadonlyArray<{ systemId: SystemId; url: string; kind: PageKind }>,
		now: string,
		options?: { keepDone?: boolean },
	): Promise<void> {
		const held =
			options?.keepDone === true
				? "page_work.status = 'done' OR page_work.status = 'claimed'"
				: "page_work.status = 'claimed'";
		for (const item of items) {
			await run(
				this.step,
				`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts)
				 VALUES (?, ?, ?, 'pending', ?, 0)
				 ON CONFLICT(system_id, url) DO UPDATE SET
				   kind = CASE
				     WHEN page_work.kind = 'seed' OR excluded.kind = 'seed' THEN 'seed'
				     ELSE excluded.kind
				   END,
				   status = CASE
				     WHEN ${held} THEN page_work.status
				     ELSE 'pending'
				   END,
				   attempts = CASE
				     WHEN ${held} THEN page_work.attempts
				     ELSE 0
				   END,
				   error = CASE
				     WHEN ${held} THEN page_work.error
				     ELSE NULL
				   END,
				   claim_token = CASE
				     WHEN ${held} THEN page_work.claim_token
				     ELSE NULL
				   END`,
				item.systemId,
				item.url,
				item.kind,
				now,
			);
		}
	}

	async claim(limit: number, now: string): Promise<ClaimedPage[]> {
		const staleBefore = new Date(Date.parse(now) - STALE_CLAIM_MS).toISOString();
		const exhaustedBefore = new Date(Date.parse(now) - EXHAUSTED_RETRY_MS).toISOString();
		// SIT-68: expiry is a lost lease, not a crawl failure. Return the row to
		// pending on this tick — including rows already failed as "claim expired" —
		// and rewind an exhausted attempt count so the lease cannot fill the dead
		// fail pile. claimed_at stays, so this system still counts as served and
		// the next batch can move on to a seed that has not had a turn.
		// SIT-70: a real failure that has used its attempts stays failed until an
		// hour after claimed_at, then takes the same rewind. A row with no claim
		// time stays failed. claim-expired rows do not wait out that hour.
		await run(
			this.step,
			`UPDATE page_work
			 SET status = 'pending',
			     error = NULL,
			     claim_token = NULL,
			     attempts = CASE WHEN attempts >= ? THEN ? ELSE attempts END
			 WHERE (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)
			    OR (status = 'failed' AND error = ?)
			    OR (
			      status = 'failed'
			      AND attempts >= ?
			      AND claimed_at IS NOT NULL
			      AND claimed_at < ?
			      AND (error IS NULL OR error != ?)
			    )`,
			MAX_ATTEMPTS,
			MAX_ATTEMPTS - 1,
			staleBefore,
			CLAIM_EXPIRED,
			MAX_ATTEMPTS,
			exhaustedBefore,
			CLAIM_EXPIRED,
		);
		// One claimable page from each system before any system repeats. The
		// served time is a single aggregate, so done rows are not ranked. A
		// system with no claim or index yet goes first within a round.
		const rows = await all<WorkRow>(
			this.step,
			`WITH served AS (
			   SELECT system_id,
			          MAX(
			            CASE
			              WHEN claimed_at IS NULL THEN last_indexed
			              WHEN last_indexed IS NULL THEN claimed_at
			              WHEN claimed_at > last_indexed THEN claimed_at
			              ELSE last_indexed
			            END
			          ) AS served_at
			   FROM page_work
			   GROUP BY system_id
			 ),
			 ranked AS (
			   SELECT
			     page_work.system_id, page_work.url, page_work.kind, page_work.status,
			     page_work.enqueued_at, page_work.attempts, page_work.last_crawled,
			     page_work.last_indexed, page_work.item_key, served.served_at,
			     ROW_NUMBER() OVER (
			       PARTITION BY page_work.system_id
			       ORDER BY
			         CASE page_work.kind WHEN 'seed' THEN 0 ELSE 1 END,
			         CASE WHEN page_work.last_indexed IS NULL THEN 0 ELSE 1 END,
			         page_work.last_indexed ASC,
			         page_work.enqueued_at ASC,
			         page_work.url ASC
			     ) AS turn
			   FROM page_work
			   JOIN served ON served.system_id = page_work.system_id
			   WHERE page_work.status = 'pending'
			      OR (page_work.status = 'failed' AND page_work.attempts < ?)
			 )
			 SELECT system_id, url, kind, status, enqueued_at, attempts, last_crawled, last_indexed, item_key
			 FROM ranked
			 ORDER BY
			   turn ASC,
			   CASE WHEN served_at IS NULL THEN 0 ELSE 1 END,
			   served_at ASC,
			   CASE kind WHEN 'seed' THEN 0 ELSE 1 END,
			   CASE WHEN last_indexed IS NULL THEN 0 ELSE 1 END,
			   last_indexed ASC,
			   enqueued_at ASC,
			   system_id ASC,
			   url ASC
			 LIMIT ?`,
			MAX_ATTEMPTS,
			limit,
		);
		const claimToken = crypto.randomUUID();
		if (this.step.tick) {
			this.step.tick.budget.openClaimToken = claimToken;
		}
		const claimed: ClaimedPage[] = [];
		for (const row of rows) {
			const item = toItem(row);
			if (!item) {
				continue;
			}
			const changes = await run(
				this.step,
				`UPDATE page_work
				 SET status = 'claimed',
				     attempts = CASE
				       WHEN page_work.status = 'claimed' AND page_work.claim_token = ? THEN page_work.attempts
				       ELSE page_work.attempts + 1
				     END,
				     claimed_at = ?,
				     claim_token = ?,
				     error = NULL
				 WHERE system_id = ? AND url = ?
				   AND (
				     page_work.status = 'pending'
				     OR page_work.status = 'failed'
				     OR (page_work.status = 'claimed' AND page_work.claim_token = ?)
				   )`,
				claimToken,
				now,
				claimToken,
				item.systemId,
				item.url,
				claimToken,
			);
			if (changes === 1) {
				claimed.push({
					...item,
					status: "claimed",
					attempts: item.attempts + 1,
					claimedAt: now,
					claimToken,
				});
			}
		}
		return this.yieldHeldPages(claimed);
	}

	// Claims are written before this read, so a later read sees an earlier claim on the same page.
	private async yieldHeldPages(claimed: ClaimedPage[]): Promise<ClaimedPage[]> {
		if (claimed.length === 0) {
			return claimed;
		}
		const mine = new Set(claimed.map((item) => `${item.systemId}\0${item.url}`));
		const rows = await all<{ system_id: string; url: string }>(
			this.step,
			"SELECT system_id, url FROM page_work WHERE status = 'claimed'",
		);
		const held = new Set<string>();
		for (const row of rows) {
			if (!isSystemId(row.system_id) || mine.has(`${row.system_id}\0${row.url}`)) {
				continue;
			}
			const lease = pageLease(row.system_id, row.url);
			if (lease !== null) {
				held.add(lease);
			}
		}
		const kept: ClaimedPage[] = [];
		for (const item of claimed) {
			const lease = pageLease(item.systemId, item.url);
			if (lease === null || !held.has(lease)) {
				kept.push(item);
				continue;
			}
			const changes = await run(
				this.step,
				`UPDATE page_work
				 SET status = 'pending', attempts = attempts - 1
				 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?`,
				item.systemId,
				item.url,
				item.attempts,
				item.claimedAt,
				item.claimToken,
			);
			if (changes === 1) {
				console.log(JSON.stringify({ event: "page_claim_yield", system: item.systemId, url: item.url }));
			} else {
				await guardedChanges(this.step, "yield", item, "pending", changes);
			}
		}
		return kept;
	}

	async complete(
		item: Pick<PageWorkItem, "systemId" | "url" | "claimToken"> & { attempts?: number; claimedAt?: string },
		timestamps: { lastCrawled: string; lastIndexed: string },
		itemKey: string | null,
		options?: { keepIndexedAt?: boolean },
	): Promise<boolean> {
		const keepIndexedAt = options?.keepIndexedAt === true;
		if (item.claimedAt !== undefined && item.attempts !== undefined) {
			const changes = await run(
				this.step,
				keepIndexedAt
					? `UPDATE page_work
					   SET status = 'done', last_crawled = ?, item_key = ?, error = NULL, claimed_at = NULL
					   WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?`
					: `UPDATE page_work
					   SET status = 'done', last_crawled = ?, last_indexed = ?, item_key = ?, error = NULL, claimed_at = NULL
					   WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?`,
				...(keepIndexedAt
					? [timestamps.lastCrawled, itemKey, item.systemId, item.url, item.attempts, item.claimedAt, item.claimToken]
					: [
							timestamps.lastCrawled,
							timestamps.lastIndexed,
							itemKey,
							item.systemId,
							item.url,
							item.attempts,
							item.claimedAt,
							item.claimToken,
						]),
			);
			return guardedChanges(this.step, "complete", item, "done", changes);
		}
		await run(
			this.step,
			keepIndexedAt
				? `UPDATE page_work
				   SET status = 'done', last_crawled = ?, item_key = ?, error = NULL, claimed_at = NULL
				   WHERE system_id = ? AND url = ?`
				: `UPDATE page_work
				   SET status = 'done', last_crawled = ?, last_indexed = ?, item_key = ?, error = NULL, claimed_at = NULL
				   WHERE system_id = ? AND url = ?`,
			...(keepIndexedAt
				? [timestamps.lastCrawled, itemKey, item.systemId, item.url]
				: [timestamps.lastCrawled, timestamps.lastIndexed, itemKey, item.systemId, item.url]),
		);
		return true;
	}

	async holdsFreshness(systemId: SystemId): Promise<boolean> {
		const deferred = await this.capDefers();
		return deferred[systemId] !== undefined;
	}

	async fail(
		item: Pick<PageWorkItem, "systemId" | "url" | "claimToken"> & { attempts?: number; claimedAt?: string },
		error: string,
	): Promise<boolean> {
		if (item.claimedAt !== undefined && item.attempts !== undefined) {
			const changes = await run(
				this.step,
				`UPDATE page_work
				 SET status = 'failed', error = ?
				 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?`,
				error,
				item.systemId,
				item.url,
				item.attempts,
				item.claimedAt,
				item.claimToken,
			);
			return guardedChanges(this.step, "fail", item, "failed", changes);
		}
		await run(
			this.step,
			`UPDATE page_work
			 SET status = 'failed', error = ?
			 WHERE system_id = ? AND url = ?`,
			error,
			item.systemId,
			item.url,
		);
		return true;
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

	async listAbsent(
		systemId: SystemId,
		liveUrls: ReadonlySet<string>,
	): Promise<Array<{ url: string; itemKey: string | null }>> {
		const rows = await all<{ url: string; item_key: string | null }>(
			this.step,
			"SELECT url, item_key FROM page_work WHERE system_id = ?",
			systemId,
		);
		return rows
			.filter((row) => !liveUrls.has(row.url))
			.map((row) => ({ url: row.url, itemKey: row.item_key }));
	}

	async removeUrls(systemId: SystemId, urls: readonly string[]): Promise<void> {
		for (const url of urls) {
			await run(this.step, "DELETE FROM page_work WHERE system_id = ? AND url = ?", systemId, url);
		}
	}

	async dropAbsent(
		systemId: SystemId,
		liveUrls: ReadonlySet<string>,
	): Promise<Array<{ url: string; itemKey: string | null }>> {
		const dropped = await this.listAbsent(systemId, liveUrls);
		await this.removeUrls(
			systemId,
			dropped.map((row) => row.url),
		);
		return dropped;
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

	async running(): Promise<DiscoverRun | null> {
		const row = await first<RunRow>(
			this.step,
			`SELECT system_id, kind, trigger_name, job_id, start_url, cursor, poll_failures, started_at
			 FROM discover_run LIMIT 1`,
		);
		if (!row || !isSystemId(row.system_id)) {
			return null;
		}
		return {
			systemId: row.system_id,
			kind: asKind(row.kind),
			trigger: asTrigger(row.trigger_name),
			jobId: row.job_id,
			startUrl: row.start_url,
			cursor: row.cursor,
			pollFailures: row.poll_failures,
			startedAt: row.started_at,
		};
	}

	async insertRun(run: DiscoverRun & { now: string }): Promise<void> {
		await runOnce(
			this.step,
			`INSERT INTO discover_run (
			   system_id, kind, trigger_name, job_id, start_url, state, cursor, poll_failures, started_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'running', NULL, 0, ?, ?)`,
			run.systemId,
			run.kind,
			run.trigger,
			run.jobId,
			run.startUrl,
			run.now,
			run.now,
		);
		await this.noteAttempt(run.systemId, run.startUrl);
		await this.noteSliceBaseline(run.systemId, await this.frontierCount(run.systemId));
	}

	async saveCursor(systemId: SystemId, cursor: string | null, now: string): Promise<void> {
		await run(
			this.step,
			"UPDATE discover_run SET cursor = ?, poll_failures = 0, updated_at = ? WHERE system_id = ?",
			cursor,
			now,
			systemId,
		);
	}

	async noteCapped(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.step,
			"UPDATE discover_run SET capped_any = 1, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
	}

	async cappedAny(systemId: SystemId): Promise<boolean> {
		const row = await first<{ capped_any: number }>(
			this.step,
			"SELECT capped_any FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return row?.capped_any === 1;
	}

	async noteSkipped(systemId: SystemId, now: string): Promise<number> {
		await runOnce(
			this.step,
			"UPDATE discover_run SET skipped_any = skipped_any + 1, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
		const row = await first<{ skipped_any: number }>(
			this.step,
			"SELECT skipped_any FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return row?.skipped_any ?? 0;
	}

	async skippedAny(systemId: SystemId): Promise<boolean> {
		const row = await first<{ skipped_any: number }>(
			this.step,
			"SELECT skipped_any FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return (row?.skipped_any ?? 0) >= 1;
	}

	async clearPollFailures(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.step,
			"UPDATE discover_run SET poll_failures = 0, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
	}

	async noteStartFailure(systemId: SystemId, now: string): Promise<number> {
		await runOnce(
			this.step,
			"UPDATE discover_run SET start_failures = start_failures + 1, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
		const row = await first<{ start_failures: number }>(
			this.step,
			"SELECT start_failures FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return row?.start_failures ?? 0;
	}

	async clearStartFailures(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.step,
			"UPDATE discover_run SET start_failures = 0, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
	}

	async notePollFailure(systemId: SystemId, now: string): Promise<number> {
		await runOnce(
			this.step,
			"UPDATE discover_run SET poll_failures = poll_failures + 1, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
		const row = await first<{ poll_failures: number }>(
			this.step,
			"SELECT poll_failures FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return row?.poll_failures ?? 0;
	}

	async rememberSliceIncomplete(systemId: SystemId): Promise<void> {
		if ((await this.cappedAny(systemId)) || (await this.skippedAny(systemId))) {
			await this.noteAttempt(systemId, INCOMPLETE_SLICE);
		}
	}

	async takeSliceIncomplete(systemId: SystemId): Promise<boolean> {
		const row = await first<{ url: string }>(
			this.step,
			"SELECT url FROM discover_attempt WHERE system_id = ? AND url = ?",
			systemId,
			INCOMPLETE_SLICE,
		);
		if (!row) {
			return false;
		}
		await run(this.step, "DELETE FROM discover_attempt WHERE system_id = ? AND url = ?", systemId, INCOMPLETE_SLICE);
		return true;
	}

	async frontierCount(systemId: SystemId): Promise<number> {
		const row = await first<{ n: number }>(
			this.step,
			"SELECT COUNT(*) AS n FROM discover_frontier WHERE system_id = ?",
			systemId,
		);
		return Number(row?.n ?? 0);
	}

	async noteSliceBaseline(systemId: SystemId, frontier: number): Promise<void> {
		await run(
			this.step,
			"UPDATE discover_run SET error = ? WHERE system_id = ?",
			sliceMark(false, frontier),
			systemId,
		);
	}

	async noteSliceAccepted(systemId: SystemId): Promise<void> {
		const row = await first<{ error: string | null }>(
			this.step,
			"SELECT error FROM discover_run WHERE system_id = ?",
			systemId,
		);
		const mark = parseSliceMark(row?.error ?? null);
		const frontier = mark?.frontier ?? (await this.frontierCount(systemId));
		await run(
			this.step,
			"UPDATE discover_run SET error = ? WHERE system_id = ?",
			sliceMark(true, frontier),
			systemId,
		);
	}

	async sliceMadeProgress(systemId: SystemId): Promise<boolean> {
		const row = await first<{ error: string | null }>(
			this.step,
			"SELECT error FROM discover_run WHERE system_id = ?",
			systemId,
		);
		const mark = parseSliceMark(row?.error ?? null);
		if (!mark) {
			return false;
		}
		return mark.accepted || (await this.frontierCount(systemId)) < mark.frontier;
	}

	async recordDiscoverResume(systemId: SystemId, seedHash: string, yieldedAt: string): Promise<void> {
		await run(
			this.step,
			`INSERT INTO discover_resume (system_id, seed_hash, yielded_at) VALUES (?, ?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET
			   seed_hash = excluded.seed_hash,
			   yielded_at = excluded.yielded_at`,
			systemId,
			seedHash,
			yieldedAt,
		);
	}

	async discoverResume(systemId: SystemId): Promise<{ seedHash: string; yieldedAt: string } | null> {
		const row = await first<{ seed_hash: string; yielded_at: string }>(
			this.step,
			"SELECT seed_hash, yielded_at FROM discover_resume WHERE system_id = ?",
			systemId,
		);
		if (!row) {
			return null;
		}
		return { seedHash: row.seed_hash, yieldedAt: row.yielded_at };
	}

	async releaseSlot(systemId: SystemId): Promise<void> {
		await run(this.step, "DELETE FROM discover_run WHERE system_id = ?", systemId);
	}

	async clearRun(systemId: SystemId): Promise<void> {
		await run(this.step, "DELETE FROM discover_indexable WHERE system_id = ?", systemId);
		await run(this.step, "DELETE FROM discover_url WHERE system_id = ?", systemId);
		await run(this.step, "DELETE FROM discover_frontier WHERE system_id = ?", systemId);
		await run(this.step, "DELETE FROM discover_attempt WHERE system_id = ?", systemId);
		await run(this.step, "DELETE FROM discover_resume WHERE system_id = ?", systemId);
		await run(this.step, "DELETE FROM discover_run WHERE system_id = ?", systemId);
	}

	async replaceJob(systemId: SystemId, jobId: string, startUrl: string, now: string): Promise<void> {
		// started_at stays put so the poll deadline covers the whole follow-up chain.
		await run(
			this.step,
			`UPDATE discover_run
			 SET job_id = ?, start_url = ?, cursor = NULL, poll_failures = 0, start_failures = 0, updated_at = ?
			 WHERE system_id = ?`,
			jobId,
			startUrl,
			now,
			systemId,
		);
		await this.noteAttempt(systemId, startUrl);
	}

	async noteAttempt(systemId: SystemId, url: string): Promise<void> {
		await run(
			this.step,
			"INSERT INTO discover_attempt (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING",
			systemId,
			url,
		);
	}

	async addFrontier(systemId: SystemId, urls: readonly string[]): Promise<void> {
		const unique = [...new Set(urls)];
		if (unique.length === 0) {
			return;
		}
		const fresh: string[] = [];
		for (const group of chunks(unique, 80)) {
			const existing = await all<{ url: string }>(
				this.step,
				`SELECT url FROM discover_frontier WHERE system_id = ? AND url IN (${group.map(() => "?").join(",")})`,
				systemId,
				...group,
			);
			const have = new Set(existing.map((row) => row.url));
			for (const url of group) {
				if (!have.has(url)) {
					fresh.push(url);
				}
			}
		}
		for (const group of chunks(fresh, 40)) {
			const values = group.map(() => "(?, ?)").join(", ");
			const params: unknown[] = [];
			for (const url of group) {
				params.push(systemId, url);
			}
			await run(
				this.step,
				`INSERT INTO discover_frontier (system_id, url) VALUES ${values} ON CONFLICT DO NOTHING`,
				...params,
			);
		}
	}

	async nextFrontier(systemId: SystemId, seen: ReadonlySet<string>): Promise<string | null> {
		const seed = seedById(systemId);
		const blocked = new Set<string>();
		for (const url of seen) {
			blocked.add(pageKey(url));
		}
		const attempted = await all<{ url: string }>(
			this.step,
			"SELECT url FROM discover_attempt WHERE system_id = ?",
			systemId,
		);
		for (const row of attempted) {
			blocked.add(pageKey(row.url));
		}
		const rows = await all<{ url: string }>(
			this.step,
			"SELECT url FROM discover_frontier WHERE system_id = ? ORDER BY url ASC",
			systemId,
		);
		const rejected: string[] = [];
		let chosen: string | null = null;
		for (const row of rows) {
			if (admittedUrl(row.url, seed) === null) {
				rejected.push(row.url);
				continue;
			}
			if (chosen === null && !blocked.has(pageKey(row.url)) && !isStaticAsset(row.url)) {
				chosen = pageKey(row.url);
			}
		}
		for (const group of chunks(rejected, 80)) {
			await run(
				this.step,
				`DELETE FROM discover_frontier WHERE system_id = ? AND url IN (${group.map(() => "?").join(",")})`,
				systemId,
				...group,
			);
		}
		return chosen;
	}

	async indexableCount(systemId: SystemId): Promise<number> {
		const row = await first<{ n: number }>(
			this.step,
			"SELECT COUNT(*) AS n FROM discover_indexable WHERE system_id = ?",
			systemId,
		);
		return Number(row?.n ?? 0);
	}

	async clearWork(systemId: SystemId): Promise<void> {
		await run(this.step, "DELETE FROM page_work WHERE system_id = ?", systemId);
	}

	async stageUrl(systemId: SystemId, url: string): Promise<void> {
		await run(
			this.step,
			"INSERT INTO discover_url (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING",
			systemId,
			url,
		);
	}

	async stagedUrls(systemId: SystemId): Promise<string[]> {
		const rows = await all<{ url: string }>(
			this.step,
			"SELECT url FROM discover_url WHERE system_id = ? ORDER BY url ASC",
			systemId,
		);
		return rows.map((row) => row.url);
	}

	async stageIndexable(systemId: SystemId, url: string): Promise<void> {
		await run(
			this.step,
			"INSERT INTO discover_indexable (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING",
			systemId,
			url,
		);
	}

	async indexableUrls(systemId: SystemId): Promise<string[]> {
		const rows = await all<{ url: string }>(
			this.step,
			"SELECT url FROM discover_indexable WHERE system_id = ? ORDER BY url ASC",
			systemId,
		);
		return rows.map((row) => row.url);
	}

	async noteRecoveryAttempt(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.step,
			`INSERT INTO recovery_attempt (system_id, attempted_at) VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET attempted_at = excluded.attempted_at`,
			systemId,
			now,
		);
	}

	async owns(item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt" | "claimToken">): Promise<boolean> {
		if (item.claimedAt === undefined || item.attempts === undefined || !item.claimToken) {
			return false;
		}
		const row = await first<{ ok: number }>(
			this.step,
			`SELECT 1 AS ok FROM page_work
			 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?`,
			item.systemId,
			item.url,
			item.attempts,
			item.claimedAt,
			item.claimToken,
		);
		return row !== null;
	}

	async releaseForRetry(
		item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt" | "claimToken">,
		itemKey: string,
	): Promise<boolean> {
		if (item.claimedAt === undefined || item.attempts === undefined) {
			return false;
		}
		const changes = await run(
			this.step,
			`UPDATE page_work
			 SET status = 'pending',
			     attempts = CASE WHEN attempts >= ? THEN ? ELSE attempts END,
			     error = NULL,
			     item_key = ?
			 WHERE system_id = ? AND url = ?
			   AND (
			     (status = 'claimed' AND attempts = ? AND claimed_at = ? AND claim_token = ?)
			     OR (status = 'failed' AND attempts = ? AND claimed_at IS NULL AND error = ?)
			   )`,
			MAX_ATTEMPTS,
			MAX_ATTEMPTS - 1,
			itemKey,
			item.systemId,
			item.url,
			item.attempts,
			item.claimedAt,
			item.claimToken,
			item.attempts,
			CLAIM_EXPIRED,
		);
		return guardedChanges(this.step, "releaseForRetry", item, "pending", changes);
	}

	async recordSeedRefresh(systemId: SystemId, seedHash: string, enqueuedAt: string): Promise<void> {
		await run(
			this.step,
			`INSERT INTO seed_refresh (system_id, seed_hash, enqueued_at) VALUES (?, ?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET seed_hash = excluded.seed_hash, enqueued_at = excluded.enqueued_at`,
			systemId,
			seedHash,
			enqueuedAt,
		);
	}

	async seedRefreshes(): Promise<Record<string, { seedHash: string; enqueuedAt: string }>> {
		const rows = await all<{ system_id: string; seed_hash: string; enqueued_at: string }>(
			this.step,
			"SELECT system_id, seed_hash, enqueued_at FROM seed_refresh",
		);
		return Object.fromEntries(
			rows.map((row) => [row.system_id, { seedHash: row.seed_hash, enqueuedAt: row.enqueued_at }]),
		);
	}

	async recoveryAttempts(): Promise<Record<string, string>> {
		const rows = await all<{ system_id: string; attempted_at: string }>(
			this.step,
			"SELECT system_id, attempted_at FROM recovery_attempt",
		);
		return Object.fromEntries(rows.map((row) => [row.system_id, row.attempted_at]));
	}

	async noteCapDefer(systemId: SystemId, now: string): Promise<void> {
		await runOnce(
			this.step,
			`INSERT INTO cap_defer (system_id, deferred_at, streak) VALUES (?, ?, 1)
			 ON CONFLICT(system_id) DO UPDATE SET
			   deferred_at = excluded.deferred_at,
			   streak = cap_defer.streak + 1`,
			systemId,
			now,
		);
	}

	async noteCapDeferBase(systemId: SystemId, now: string): Promise<void> {
		await runOnce(
			this.step,
			`INSERT INTO cap_defer (system_id, deferred_at, streak) VALUES (?, ?, 1)
			 ON CONFLICT(system_id) DO UPDATE SET
			   deferred_at = excluded.deferred_at,
			   streak = 1`,
			systemId,
			now,
		);
	}

	async clearCapDefer(systemId: SystemId): Promise<void> {
		await run(this.step, "DELETE FROM cap_defer WHERE system_id = ?", systemId);
	}

	async capDefers(): Promise<Record<string, string>> {
		const marks = await this.capDeferMarks();
		return Object.fromEntries(Object.entries(marks).map(([systemId, mark]) => [systemId, mark.at]));
	}

	async capDeferMarks(): Promise<Record<string, { at: string; streak: number }>> {
		const rows = await all<{ system_id: string; deferred_at: string; streak: number }>(
			this.step,
			"SELECT system_id, deferred_at, streak FROM cap_defer",
		);
		return Object.fromEntries(
			rows.map((row) => [row.system_id, { at: row.deferred_at, streak: row.streak }]),
		);
	}

	async markDiscovered(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.step,
			`INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET last_discovered = excluded.last_discovered`,
			systemId,
			now,
		);
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

	async releaseOpenClaims(claimToken: string): Promise<void> {
		await runBypass(
			this.step,
			`UPDATE page_work
			 SET status = 'pending',
			     attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
			     claimed_at = NULL,
			     claim_token = NULL,
			     error = NULL
			 WHERE status = 'claimed' AND claim_token = ?`,
			claimToken,
		);
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

function parseSliceMark(error: string | null): { accepted: boolean; frontier: number } | null {
	const match = SLICE_MARK.exec(error ?? "");
	if (!match) {
		return null;
	}
	return { accepted: match[1] === "1", frontier: Number(match[2]) };
}

function sliceMark(accepted: boolean, frontier: number): string {
	return `slice:${accepted ? "1" : "0"}:${frontier}`;
}

function pageLease(systemId: SystemId, url: string): string | null {
	const page = admittedUrl(url, seedById(systemId));
	return page === null ? null : `${systemId}\0${page}`;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		groups.push(values.slice(index, index + size));
	}
	return groups;
}

export function isDue(input: {
	lastIndexed: string | null;
	lastDiscovered: string | null;
	pending: number;
	now: number;
}): boolean {
	if (input.pending > 0) {
		return false;
	}
	const indexedStale = input.lastIndexed === null || input.now - Date.parse(input.lastIndexed) > FRESHNESS_MS;
	if (!indexedStale) {
		return false;
	}
	if (input.lastDiscovered !== null && input.now - Date.parse(input.lastDiscovered) <= FRESHNESS_MS) {
		return false;
	}
	return true;
}
