import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SystemId } from "../../src/config/types.ts";

export function applyMigrations(db: DatabaseSync): void {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort();
	for (const name of files) {
		db.exec(readFileSync(join(dir, name), "utf8"));
	}
}

export function memoryD1(): D1Database {
	const db = new DatabaseSync(":memory:");
	applyMigrations(db);
	const statement = (sql: string, values: SQLInputValue[]) => ({
		sql,
		values,
		async all<T>() {
			const stmt = db.prepare(sql);
			const results = (values.length > 0 ? stmt.all(...values) : stmt.all()) as T[];
			return { results };
		},
		async run() {
			const stmt = db.prepare(sql);
			const info = values.length > 0 ? stmt.run(...values) : stmt.run();
			return { success: true as const, meta: { changes: Number(info.changes) } };
		},
		async first<T>() {
			const stmt = db.prepare(sql);
			const row = (values.length > 0 ? stmt.get(...values) : stmt.get()) as T | undefined;
			return row ?? null;
		},
	});
	const prepare = (sql: string) => {
		const bound = statement(sql, []);
		return {
			bind: (...params: unknown[]) =>
				statement(sql, params.map((value) => (value === undefined ? null : value)) as SQLInputValue[]),
			all: <T>() => bound.all<T>(),
			run: () => bound.run(),
			first: <T>() => bound.first<T>(),
		};
	};
	return {
		prepare,
		async exec(sql: string) {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		async batch(statements: Array<{ sql: string; values: SQLInputValue[] }>) {
			db.exec("BEGIN");
			try {
				const results = [];
				for (const entry of statements) {
					const stmt = db.prepare(entry.sql);
					if (/^\s*select/i.test(entry.sql)) {
						const rows = entry.values.length > 0 ? stmt.all(...entry.values) : stmt.all();
						results.push({ success: true as const, meta: { changes: 0 }, results: rows });
						continue;
					}
					const info = entry.values.length > 0 ? stmt.run(...entry.values) : stmt.run();
					results.push({ success: true as const, meta: { changes: Number(info.changes) }, results: [] });
				}
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

export async function stampClaim(db: D1Database, systemId: SystemId, url: string, claimedAt: string) {
	await db
		.prepare(
			"UPDATE page_work SET status = 'claimed', claimed_at = ?, claim_token = ? WHERE system_id = ? AND url = ? AND status = 'pending' AND attempts = 0",
		)
		.bind(claimedAt, "fixture-claim", systemId, url)
		.run();
	return { systemId, url, attempts: 0, claimedAt, claimToken: "fixture-claim" };
}
