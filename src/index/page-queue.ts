import { SYSTEM_IDS, isSystemId, type SystemId } from "../config/types.ts";

export const DRAIN_LIMIT = 100;
export const MAX_ATTEMPTS = 5;
export const FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_CLAIM_MS = 15 * 60 * 1000;
const CLAIM_EXPIRED = "claim expired";

export const PAGE_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_work (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_crawled TEXT,
  last_indexed TEXT,
  claimed_at TEXT,
  error TEXT,
  item_key TEXT,
  PRIMARY KEY (system_id, url)
);

CREATE TABLE IF NOT EXISTS discover_run (
  system_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  start_url TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor TEXT,
  poll_failures INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discover_url (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

CREATE TABLE IF NOT EXISTS system_mark (
  system_id TEXT PRIMARY KEY,
  last_discovered TEXT
);

CREATE TABLE IF NOT EXISTS discover_indexable (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

CREATE TABLE IF NOT EXISTS recovery_attempt (
  system_id TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seed_refresh (
  system_id TEXT PRIMARY KEY,
  seed_hash TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);
`;

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
};

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
	): Promise<void>;
	claim(limit: number, now: string): Promise<PageWorkItem[]>;
	complete(
		item: Pick<PageWorkItem, "systemId" | "url"> & { attempts?: number; claimedAt?: string },
		timestamps: { lastCrawled: string; lastIndexed: string },
		itemKey: string | null,
	): Promise<boolean>;
	fail(
		item: Pick<PageWorkItem, "systemId" | "url"> & { attempts?: number; claimedAt?: string },
		error: string,
	): Promise<boolean>;
	owns(item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt">): Promise<boolean>;
	releaseForRetry(
		item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt">,
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

const ready = new WeakMap<D1Database, Promise<void>>();

export function emptyDepths(): QueueDepths {
	return { pending: 0, claimed: 0, failed: 0, done: 0 };
}

export function ensurePageQueue(db: D1Database): Promise<void> {
	let pending = ready.get(db);
	if (!pending) {
		pending = db.exec(PAGE_QUEUE_SCHEMA).then(
			() => undefined,
			async (error: unknown) => {
				try {
					await db.prepare("SELECT 1 AS ok FROM page_work LIMIT 1").all();
				} catch {
					ready.delete(db);
					throw error;
				}
			},
		);
		ready.set(db, pending);
	}
	return pending;
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

async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
	const result = await db.prepare(sql).bind(...params).all<T>();
	return result.results ?? [];
}

async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
	const row = await db.prepare(sql).bind(...params).first<T>();
	return row ?? null;
}

async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
	const result = await db.prepare(sql).bind(...params).run();
	return result.meta?.changes ?? 0;
}

export class D1PageQueue implements PageQueue {
	constructor(private readonly db: D1Database) {}

	ensure(): Promise<void> {
		return ensurePageQueue(this.db);
	}

	async enqueueUpsert(
		items: ReadonlyArray<{ systemId: SystemId; url: string; kind: PageKind }>,
		now: string,
	): Promise<void> {
		for (const item of items) {
			await run(
				this.db,
				`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts)
				 VALUES (?, ?, ?, 'pending', ?, 0)
				 ON CONFLICT(system_id, url) DO UPDATE SET
				   kind = CASE
				     WHEN page_work.kind = 'seed' OR excluded.kind = 'seed' THEN 'seed'
				     ELSE excluded.kind
				   END,
				   status = CASE
				     WHEN page_work.status = 'claimed' THEN page_work.status
				     ELSE 'pending'
				   END,
				   attempts = CASE
				     WHEN page_work.status = 'claimed' THEN page_work.attempts
				     ELSE 0
				   END,
				   error = CASE
				     WHEN page_work.status = 'claimed' THEN page_work.error
				     ELSE NULL
				   END`,
				item.systemId,
				item.url,
				item.kind,
				now,
			);
		}
	}

	async claim(limit: number, now: string): Promise<PageWorkItem[]> {
		const staleBefore = new Date(Date.parse(now) - STALE_CLAIM_MS).toISOString();
		await run(
			this.db,
			`UPDATE page_work
			 SET status = 'pending', claimed_at = NULL
			 WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? AND attempts < ?`,
			staleBefore,
			MAX_ATTEMPTS,
		);
		await run(
			this.db,
			`UPDATE page_work
			 SET status = 'failed', claimed_at = NULL, error = COALESCE(error, '${CLAIM_EXPIRED}')
			 WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? AND attempts >= ?`,
			staleBefore,
			MAX_ATTEMPTS,
		);
		const rows = await all<WorkRow>(
			this.db,
			`SELECT system_id, url, kind, status, enqueued_at, attempts, last_crawled, last_indexed, item_key
			 FROM page_work
			 WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
			 ORDER BY
			   CASE kind WHEN 'seed' THEN 0 ELSE 1 END,
			   CASE WHEN last_indexed IS NULL THEN 0 ELSE 1 END,
			   last_indexed ASC,
			   enqueued_at ASC
			 LIMIT ?`,
			MAX_ATTEMPTS,
			limit,
		);
		const claimed: PageWorkItem[] = [];
		for (const row of rows) {
			const item = toItem(row);
			if (!item) {
				continue;
			}
			const changes = await run(
				this.db,
				`UPDATE page_work
				 SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, error = NULL
				 WHERE system_id = ? AND url = ? AND (status = 'pending' OR status = 'failed')`,
				now,
				item.systemId,
				item.url,
			);
			if (changes === 1) {
				claimed.push({ ...item, status: "claimed", attempts: item.attempts + 1, claimedAt: now });
			}
		}
		return claimed;
	}

	async complete(
		item: Pick<PageWorkItem, "systemId" | "url"> & { attempts?: number; claimedAt?: string },
		timestamps: { lastCrawled: string; lastIndexed: string },
		itemKey: string | null,
	): Promise<boolean> {
		if (item.claimedAt !== undefined && item.attempts !== undefined) {
			const changes = await run(
				this.db,
				`UPDATE page_work
				 SET status = 'done', last_crawled = ?, last_indexed = ?, item_key = ?, error = NULL, claimed_at = NULL
				 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ?`,
				timestamps.lastCrawled,
				timestamps.lastIndexed,
				itemKey,
				item.systemId,
				item.url,
				item.attempts,
				item.claimedAt,
			);
			return changes === 1;
		}
		await run(
			this.db,
			`UPDATE page_work
			 SET status = 'done', last_crawled = ?, last_indexed = ?, item_key = ?, error = NULL, claimed_at = NULL
			 WHERE system_id = ? AND url = ?`,
			timestamps.lastCrawled,
			timestamps.lastIndexed,
			itemKey,
			item.systemId,
			item.url,
		);
		return true;
	}

	async fail(
		item: Pick<PageWorkItem, "systemId" | "url"> & { attempts?: number; claimedAt?: string },
		error: string,
	): Promise<boolean> {
		if (item.claimedAt !== undefined && item.attempts !== undefined) {
			const changes = await run(
				this.db,
				`UPDATE page_work
				 SET status = 'failed', error = ?, claimed_at = NULL
				 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ?`,
				error,
				item.systemId,
				item.url,
				item.attempts,
				item.claimedAt,
			);
			return changes === 1;
		}
		await run(
			this.db,
			`UPDATE page_work
			 SET status = 'failed', error = ?, claimed_at = NULL
			 WHERE system_id = ? AND url = ?`,
			error,
			item.systemId,
			item.url,
		);
		return true;
	}

	async depths(): Promise<QueueDepths> {
		const rows = await all<{ status: string; n: number }>(
			this.db,
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
			this.db,
			"SELECT url, item_key FROM page_work WHERE system_id = ?",
			systemId,
		);
		return rows
			.filter((row) => !liveUrls.has(row.url))
			.map((row) => ({ url: row.url, itemKey: row.item_key }));
	}

	async removeUrls(systemId: SystemId, urls: readonly string[]): Promise<void> {
		for (const url of urls) {
			await run(this.db, "DELETE FROM page_work WHERE system_id = ? AND url = ?", systemId, url);
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
			this.db,
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
			this.db,
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
			this.db,
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
		await runSql(
			this.db,
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
	}

	async saveCursor(systemId: SystemId, cursor: string | null, now: string): Promise<void> {
		await run(
			this.db,
			"UPDATE discover_run SET cursor = ?, poll_failures = 0, updated_at = ? WHERE system_id = ?",
			cursor,
			now,
			systemId,
		);
	}

	async notePollFailure(systemId: SystemId, now: string): Promise<number> {
		await run(
			this.db,
			"UPDATE discover_run SET poll_failures = poll_failures + 1, updated_at = ? WHERE system_id = ?",
			now,
			systemId,
		);
		const row = await first<{ poll_failures: number }>(
			this.db,
			"SELECT poll_failures FROM discover_run WHERE system_id = ?",
			systemId,
		);
		return row?.poll_failures ?? 0;
	}

	async clearRun(systemId: SystemId): Promise<void> {
		await run(this.db, "DELETE FROM discover_indexable WHERE system_id = ?", systemId);
		await run(this.db, "DELETE FROM discover_url WHERE system_id = ?", systemId);
		await run(this.db, "DELETE FROM discover_run WHERE system_id = ?", systemId);
	}

	async clearWork(systemId: SystemId): Promise<void> {
		await run(this.db, "DELETE FROM page_work WHERE system_id = ?", systemId);
	}

	async stageUrl(systemId: SystemId, url: string): Promise<void> {
		await run(
			this.db,
			"INSERT INTO discover_url (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING",
			systemId,
			url,
		);
	}

	async stagedUrls(systemId: SystemId): Promise<string[]> {
		const rows = await all<{ url: string }>(
			this.db,
			"SELECT url FROM discover_url WHERE system_id = ? ORDER BY url ASC",
			systemId,
		);
		return rows.map((row) => row.url);
	}

	async stageIndexable(systemId: SystemId, url: string): Promise<void> {
		await run(
			this.db,
			"INSERT INTO discover_indexable (system_id, url) VALUES (?, ?) ON CONFLICT DO NOTHING",
			systemId,
			url,
		);
	}

	async indexableUrls(systemId: SystemId): Promise<string[]> {
		const rows = await all<{ url: string }>(
			this.db,
			"SELECT url FROM discover_indexable WHERE system_id = ? ORDER BY url ASC",
			systemId,
		);
		return rows.map((row) => row.url);
	}

	async noteRecoveryAttempt(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.db,
			`INSERT INTO recovery_attempt (system_id, attempted_at) VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET attempted_at = excluded.attempted_at`,
			systemId,
			now,
		);
	}

	async owns(item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt">): Promise<boolean> {
		if (item.claimedAt === undefined || item.attempts === undefined) {
			return false;
		}
		const row = await first<{ ok: number }>(
			this.db,
			`SELECT 1 AS ok FROM page_work
			 WHERE system_id = ? AND url = ? AND status = 'claimed' AND attempts = ? AND claimed_at = ?`,
			item.systemId,
			item.url,
			item.attempts,
			item.claimedAt,
		);
		return row !== null;
	}

	async releaseForRetry(
		item: Pick<PageWorkItem, "systemId" | "url" | "attempts" | "claimedAt">,
		itemKey: string,
	): Promise<boolean> {
		if (item.claimedAt === undefined || item.attempts === undefined) {
			return false;
		}
		const changes = await run(
			this.db,
			`UPDATE page_work
			 SET status = 'pending',
			     attempts = CASE WHEN attempts >= ? THEN ? ELSE attempts END,
			     claimed_at = NULL,
			     error = NULL,
			     item_key = ?
			 WHERE system_id = ? AND url = ?
			   AND (
			     (status = 'claimed' AND attempts = ? AND claimed_at = ?)
			     OR (status = 'failed' AND attempts = ? AND claimed_at IS NULL AND error = ?)
			   )`,
			MAX_ATTEMPTS,
			MAX_ATTEMPTS - 1,
			itemKey,
			item.systemId,
			item.url,
			item.attempts,
			item.claimedAt,
			item.attempts,
			CLAIM_EXPIRED,
		);
		return changes === 1;
	}

	async recordSeedRefresh(systemId: SystemId, seedHash: string, enqueuedAt: string): Promise<void> {
		await run(
			this.db,
			`INSERT INTO seed_refresh (system_id, seed_hash, enqueued_at) VALUES (?, ?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET seed_hash = excluded.seed_hash, enqueued_at = excluded.enqueued_at`,
			systemId,
			seedHash,
			enqueuedAt,
		);
	}

	async seedRefreshes(): Promise<Record<string, { seedHash: string; enqueuedAt: string }>> {
		const rows = await all<{ system_id: string; seed_hash: string; enqueued_at: string }>(
			this.db,
			"SELECT system_id, seed_hash, enqueued_at FROM seed_refresh",
		);
		return Object.fromEntries(
			rows.map((row) => [row.system_id, { seedHash: row.seed_hash, enqueuedAt: row.enqueued_at }]),
		);
	}

	async recoveryAttempts(): Promise<Record<string, string>> {
		const rows = await all<{ system_id: string; attempted_at: string }>(
			this.db,
			"SELECT system_id, attempted_at FROM recovery_attempt",
		);
		return Object.fromEntries(rows.map((row) => [row.system_id, row.attempted_at]));
	}

	async markDiscovered(systemId: SystemId, now: string): Promise<void> {
		await run(
			this.db,
			`INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET last_discovered = excluded.last_discovered`,
			systemId,
			now,
		);
	}
}

async function runSql(db: D1Database, sql: string, ...params: unknown[]): Promise<void> {
	await run(db, sql, ...params);
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
