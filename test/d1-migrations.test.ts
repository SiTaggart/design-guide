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
		expect(columns.results.map((column) => column.name)).toEqual(PAGE_WORK_COLUMNS);
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
		const migrate = yml.indexOf("bunx wrangler d1 migrations apply PAGE_QUEUE --remote");
		const deploy = yml.indexOf("bunx wrangler deploy");
		expect(migrate).toBeGreaterThan(-1);
		expect(deploy).toBeGreaterThan(migrate);
		expect(yml).not.toContain("continue-on-error");
	});
});
