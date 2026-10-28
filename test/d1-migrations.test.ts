import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memoryD1 } from "./helpers/d1.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGE_WORK_COLUMNS = [
	"system_id",
	"url",
	"kind",
	"status",
	"enqueued_at",
	"attempts",
	"last_crawled",
	"last_indexed",
	"claimed_at",
	"error",
	"item_key",
];

const PAGE_WORK_COLUMNS_NOW = [...PAGE_WORK_COLUMNS, "claim_token"];

const MIGRATIONS = [
	"0001_page_queue.sql",
	"0002_fill_guards.sql",
	"0003_seed_refresh.sql",
	"0004_cap_defer.sql",
	"0005_discover_frontier.sql",
	"0006_discover_attempt.sql",
	"0007_discover_capped_any.sql",
	"0008_discover_skipped_any.sql",
	"0009_discover_start_failures.sql",
	"0010_cap_defer_streak.sql",
	"0011_page_work.sql",
	"0012_fill_lease.sql",
	"0013_claim_token.sql",
	"0014_discover_resume.sql",
	"0015_discover_run_drop_state.sql",
	"0016_queue.sql",
	"0017_drop_discover.sql",
];

function filesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			found.push(...filesUnder(path));
			continue;
		}
		found.push(path);
	}
	return found;
}

describe("page queue migrations", () => {
	it("creates page_work from the migration, and applying that file again changes nothing", () => {
		const sql = readFileSync(join(root, "migrations/0011_page_work.sql"), "utf8");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS page_work");
		expect(sql).toContain("PRIMARY KEY (system_id, url)");
		for (const column of PAGE_WORK_COLUMNS) {
			expect(sql).toContain(column);
		}
		const db = new DatabaseSync(":memory:");
		db.exec(sql);
		db.exec(sql);
		const columns = db.prepare("PRAGMA table_info(page_work)").all() as Array<{ name: string; pk: number }>;
		expect(columns.map((column) => column.name)).toEqual(PAGE_WORK_COLUMNS);
		expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(["system_id", "url"]);
	});

	it("applies every migration in test setup, including the current page_work columns", async () => {
		const db = memoryD1();
		const columns = await db.prepare("PRAGMA table_info(page_work)").all<{ name: string }>();
		expect(columns.results.map((column) => column.name)).toEqual(PAGE_WORK_COLUMNS_NOW);
		const lease = await db.prepare("PRAGMA table_info(fill_lease)").all<{ name: string }>();
		expect(lease.results.map((column) => column.name)).toEqual(["id", "owner", "claimed_at"]);
		const queue = await db.prepare("PRAGMA table_info(queue)").all<{ name: string }>();
		expect(queue.results.map((column) => column.name)).toEqual([
			"url",
			"system_id",
			"enqueued_at",
			"error",
			"op",
		]);
		const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
		const names = tables.results.map((row) => row.name);
		expect(names).not.toContain("discover_run");
		expect(names).not.toContain("discover_resume");
		expect(names).not.toContain("cap_defer");
		const migrated = new DatabaseSync(":memory:");
		const tableNames = (sqlite: DatabaseSync) =>
			(sqlite.prepare("PRAGMA table_info(discover_run)").all() as Array<{ name: string }>).map((row) => row.name);
		const dropState = "0015_discover_run_drop_state.sql";
		const beforeDrop = MIGRATIONS.slice(0, MIGRATIONS.indexOf(dropState));
		for (const name of beforeDrop) migrated.exec(readFileSync(join(root, "migrations", name), "utf8"));
		expect(tableNames(migrated)).toEqual(expect.arrayContaining(["state", "error", "slice_frontier_start", "slice_accepted"]));
		migrated.exec(readFileSync(join(root, "migrations", dropState), "utf8"));
		expect(tableNames(migrated)).not.toContain("state");
		expect(tableNames(migrated)).toEqual(expect.arrayContaining(["slice_frontier_start", "slice_accepted"]));
		migrated.exec(readFileSync(join(root, "migrations/0017_drop_discover.sql"), "utf8"));
		expect(tableNames(migrated)).toEqual([]);
	});

	it("adds slice progress columns in the discover_resume migration", () => {
		const sql = readFileSync(join(root, "migrations/0014_discover_resume.sql"), "utf8");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS discover_resume");
		expect(sql).toContain("ALTER TABLE discover_run ADD COLUMN slice_frontier_start INTEGER");
		expect(sql).toContain("ALTER TABLE discover_run ADD COLUMN slice_accepted INTEGER NOT NULL DEFAULT 0");
	});

	it("adds claim_token in its own migration", () => {
		const sql = readFileSync(join(root, "migrations/0013_claim_token.sql"), "utf8");
		expect(sql).toContain("ALTER TABLE page_work ADD COLUMN claim_token");
	});

	it("creates the fill lease with IF NOT EXISTS", () => {
		const sql = readFileSync(join(root, "migrations/0012_fill_lease.sql"), "utf8");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS fill_lease");
		expect(sql).toContain("PRIMARY KEY");
	});

	it("keeps CREATE TABLE out of the worker source", () => {
		const hits = filesUnder(join(root, "src")).filter((path) => readFileSync(path, "utf8").includes("CREATE TABLE"));
		expect(hits).toEqual([]);
	});

	it("applies remote D1 migrations before the worker deploy, and a failed step stops the job", () => {
		const yml = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
		const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
		const migrations = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();
		expect(migrations).toEqual(MIGRATIONS);
		expect(wrangler).toContain('"migrations_dir": "migrations"');
		const applyLine = yml.split("\n").find((line) => line.includes("migrations apply"));
		expect(applyLine).toContain("bunx wrangler d1 migrations apply PAGE_QUEUE --remote");
		expect(applyLine).not.toMatch(/\.sql/);
		const migrate = yml.indexOf("bunx wrangler d1 migrations apply PAGE_QUEUE --remote");
		const deploy = yml.indexOf("bunx wrangler deploy");
		expect(migrate).toBeGreaterThan(-1);
		expect(deploy).toBeGreaterThan(migrate);
		expect(yml).not.toContain("continue-on-error");
	});
});
