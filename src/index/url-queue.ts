import { isSystemId, type SystemId } from "../config/types.ts";

export type QueueOp = "fetch" | "delete" | "sitemap" | "seen";

export type QueueRow = {
	url: string;
	systemId: SystemId;
	enqueuedAt: string;
	error: string | null;
	op: QueueOp;
};

type QueueSqlRow = {
	url: string;
	system_id: string;
	enqueued_at: string;
	error: string | null;
	op: string;
};

function isOp(value: string): value is QueueOp {
	return value === "fetch" || value === "delete" || value === "sitemap" || value === "seen";
}

function toRow(row: QueueSqlRow): QueueRow | null {
	if (!isSystemId(row.system_id) || !isOp(row.op)) {
		return null;
	}
	return {
		url: row.url,
		systemId: row.system_id,
		enqueuedAt: row.enqueued_at,
		error: row.error,
		op: row.op,
	};
}

export class UrlQueue {
	constructor(private readonly db: D1Database) {}

	async enqueue(
		rows: readonly { url: string; systemId: SystemId; op: QueueOp }[],
		clock: { ms: number },
	): Promise<number> {
		let added = 0;
		for (const row of rows) {
			const enqueuedAt = new Date(clock.ms).toISOString();
			clock.ms += 1;
			const result = await this.db
				.prepare(
					`INSERT INTO queue (url, system_id, enqueued_at, op)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(url) DO NOTHING`,
				)
				.bind(row.url, row.systemId, enqueuedAt, row.op)
				.run();
			added += result.meta.changes;
		}
		return added;
	}

	async takeOldest(limit: number): Promise<QueueRow[]> {
		const listed = await this.db
			.prepare(
				`SELECT url, system_id, enqueued_at, error, op
				 FROM (
				   SELECT
				     url,
				     system_id,
				     enqueued_at,
				     error,
				     op,
				     ROW_NUMBER() OVER (
				       PARTITION BY system_id
				       ORDER BY enqueued_at ASC, url ASC
				     ) AS turn
				   FROM queue
				   WHERE op != 'seen'
				 ) AS ranked
				 ORDER BY turn ASC, enqueued_at ASC, url ASC
				 LIMIT ?`,
			)
			.bind(limit)
			.all<QueueSqlRow>();
		const rows: QueueRow[] = [];
		for (const row of listed.results) {
			const parsed = toRow(row);
			if (parsed) {
				rows.push(parsed);
			}
		}
		return rows;
	}

	async remove(url: string): Promise<void> {
		await this.db.prepare("DELETE FROM queue WHERE url = ?").bind(url).run();
	}

	async completeSitemap(url: string): Promise<void> {
		await this.db.prepare("UPDATE queue SET op = 'seen', error = NULL WHERE url = ?").bind(url).run();
		const left = await this.db
			.prepare("SELECT COUNT(*) AS n FROM queue WHERE op = 'sitemap'")
			.first<{ n: number }>();
		if ((left?.n ?? 0) === 0) {
			await this.db.prepare("DELETE FROM queue WHERE op = 'seen'").run();
		}
	}

	async commitCopy(systemId: SystemId, url: string, hash: string): Promise<void> {
		await this.db.batch([
			this.db.prepare("DELETE FROM page_copy WHERE url = ?").bind(url),
			this.db
				.prepare("INSERT INTO page_copy (url, system_id, content_hash) VALUES (?, ?, ?)")
				.bind(url, systemId, hash),
		]);
	}

	async sendBack(url: string, enqueuedAt: string, error: string): Promise<void> {
		await this.db
			.prepare("UPDATE queue SET enqueued_at = ?, error = ? WHERE url = ?")
			.bind(enqueuedAt, error, url)
			.run();
	}

	async depth(): Promise<number> {
		const row = await this.db
			.prepare("SELECT COUNT(*) AS n FROM queue WHERE op != 'seen'")
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	async oldest(): Promise<{ url: string; enqueuedAt: string } | null> {
		const row = await this.db
			.prepare("SELECT url, enqueued_at FROM queue WHERE op != 'seen' ORDER BY enqueued_at ASC, url ASC LIMIT 1")
			.first<{ url: string; enqueued_at: string }>();
		if (!row) {
			return null;
		}
		return { url: row.url, enqueuedAt: row.enqueued_at };
	}

	async has(url: string): Promise<boolean> {
		const row = await this.db.prepare("SELECT url FROM queue WHERE url = ?").bind(url).first<{ url: string }>();
		return row !== null;
	}

	async list(): Promise<QueueRow[]> {
		const listed = await this.db
			.prepare(
				`SELECT url, system_id, enqueued_at, error, op
				 FROM queue
				 WHERE op != 'seen'
				 ORDER BY enqueued_at ASC, url ASC`,
			)
			.all<QueueSqlRow>();
		const rows: QueueRow[] = [];
		for (const row of listed.results) {
			const parsed = toRow(row);
			if (parsed) {
				rows.push(parsed);
			}
		}
		return rows;
	}

	async errorCount(): Promise<number> {
		const row = await this.db
			.prepare("SELECT COUNT(*) AS n FROM queue WHERE error IS NOT NULL")
			.first<{ n: number }>();
		return row?.n ?? 0;
	}
}

export type SystemMark = {
	lastDiscovered: string | null;
};

export async function readMarks(db: D1Database): Promise<Map<SystemId, SystemMark>> {
	const listed = await db
		.prepare("SELECT system_id, last_discovered FROM system_mark")
		.all<{ system_id: string; last_discovered: string | null }>();
	const marks = new Map<SystemId, SystemMark>();
	for (const row of listed.results) {
		if (!isSystemId(row.system_id)) {
			continue;
		}
		marks.set(row.system_id, { lastDiscovered: row.last_discovered });
	}
	return marks;
}

export async function writeMark(db: D1Database, systemId: SystemId, mark: SystemMark): Promise<void> {
	await db
		.prepare(
			`INSERT INTO system_mark (system_id, last_discovered)
			 VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET last_discovered = excluded.last_discovered`,
		)
		.bind(systemId, mark.lastDiscovered)
		.run();
}
