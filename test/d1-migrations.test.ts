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
	"0017_page_copy.sql",
	"0018_clear_discover_run.sql",
	"0019_canonical_urls.sql",
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
		const resume = await db.prepare("PRAGMA table_info(discover_resume)").all<{ name: string }>();
		expect(resume.results.map((column) => column.name)).toEqual(["system_id", "seed_hash", "yielded_at"]);
		const discoverRun = await db.prepare("PRAGMA table_info(discover_run)").all<{ name: string }>();
		const freshNames = discoverRun.results.map((column) => column.name);
		const migrated = new DatabaseSync(":memory:");
		const tableNames = (sqlite: DatabaseSync) =>
			(sqlite.prepare("PRAGMA table_info(discover_run)").all() as Array<{ name: string }>).map((row) => row.name);
		const dropState = "0015_discover_run_drop_state.sql";
		const beforeDrop = MIGRATIONS.slice(0, MIGRATIONS.indexOf(dropState));
		const afterDrop = MIGRATIONS.slice(MIGRATIONS.indexOf(dropState));
		for (const name of beforeDrop) migrated.exec(readFileSync(join(root, "migrations", name), "utf8"));
		expect(tableNames(migrated)).toEqual(expect.arrayContaining(["state", "error", "slice_frontier_start", "slice_accepted"]));
		for (const name of afterDrop) migrated.exec(readFileSync(join(root, "migrations", name), "utf8"));
		const migratedNames = tableNames(migrated);
		expect(migratedNames).toEqual(freshNames);
		for (const names of [freshNames, migratedNames]) {
			expect(names).not.toContain("state");
			expect(names).not.toContain("error");
		}
		expect(freshNames).toEqual(expect.arrayContaining(["slice_frontier_start", "slice_accepted"]));
	});

	it("adds slice progress columns in the discover_resume migration", () => {
		const sql = readFileSync(join(root, "migrations/0014_discover_resume.sql"), "utf8");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS discover_resume");
		expect(sql).toContain("ALTER TABLE discover_run ADD COLUMN slice_frontier_start INTEGER");
		expect(sql).toContain("ALTER TABLE discover_run ADD COLUMN slice_accepted INTEGER NOT NULL DEFAULT 0");
	});

	it("deletes discover_run rows once", () => {
		const db = new DatabaseSync(":memory:");
		const clear = "0018_clear_discover_run.sql";
		for (const name of MIGRATIONS.slice(0, MIGRATIONS.indexOf(clear))) {
			db.exec(readFileSync(join(root, "migrations", name), "utf8"));
		}
		db.prepare(
			`INSERT INTO discover_run (
			   system_id, kind, trigger_name, job_id, start_url, poll_failures, started_at, updated_at
			 ) VALUES ('patternfly', 'seed', 'deploy-drift', 'job-patternfly', 'https://www.patternfly.org/', 0, ?, ?)`,
		).run("2026-10-29T17:20:00.000Z", "2026-10-29T17:20:00.000Z");
		db.exec(readFileSync(join(root, "migrations", clear), "utf8"));
		const left = db.prepare("SELECT COUNT(*) AS n FROM discover_run").get() as { n: number };
		expect(left.n).toBe(0);
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

	it("collapses url spellings and drops excluded primer rows", () => {
		const db = new DatabaseSync(":memory:");
		const canon = "0019_canonical_urls.sql";
		for (const name of MIGRATIONS.slice(0, MIGRATIONS.indexOf(canon))) {
			db.exec(readFileSync(join(root, "migrations", name), "utf8"));
		}
		const insertPage = db.prepare(
			`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts, last_indexed)
			 VALUES (?, ?, ?, ?, ?, 0, ?)`,
		);
		insertPage.run("primer", "https://primer.style/product/button/", "seed", "pending", "2026-10-02T00:00:00.000Z", null);
		insertPage.run(
			"primer",
			"https://primer.style/product/button?view=1",
			"reindex",
			"done",
			"2026-10-03T00:00:00.000Z",
			"2026-10-03T00:00:00.000Z",
		);
		insertPage.run("primer", "https://primer.style/Product/Button", "seed", "done", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
		insertPage.run(
			"primer",
			"https://primer.style/view-components/lookbook/inspect/button",
			"seed",
			"pending",
			"2026-10-01T00:00:00.000Z",
			null,
		);
		insertPage.run(
			"primer",
			"https://primer.style/view-components/components/button/_list",
			"seed",
			"pending",
			"2026-10-01T00:00:00.000Z",
			null,
		);
		insertPage.run("primer", "https://primer.style/octicons/icon/shield-lock-24/", "seed", "pending", "2026-10-01T00:00:00.000Z", null);
		insertPage.run("primer", "https://primer.style/foundations/icons", "seed", "done", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
		insertPage.run("primer", "https://primer.style:443/brand/logo/", "seed", "done", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
		insertPage.run(
			"primer",
			"https://primer.style/view-components/Lookbook/inspect",
			"seed",
			"done",
			"2026-09-03T00:00:00.000Z",
			"2026-09-03T00:00:00.000Z",
		);
		insertPage.run("govuk", "https://design-system.service.gov.uk/components/button/", "seed", "pending", "2026-10-04T00:00:00.000Z", null);
		insertPage.run("govuk", "https://design-system.service.gov.uk/components/button", "seed", "done", "2026-10-05T00:00:00.000Z", null);
		insertPage.run("uswds", "https://designsystem.digital.gov/components/button", "seed", "done", "2026-10-06T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
		const insertQueue = db.prepare("INSERT INTO queue (url, system_id, enqueued_at, op) VALUES (?, ?, ?, 'fetch')");
		insertQueue.run("https://primer.style/product/button/", "primer", "2026-10-30T00:00:01.000Z");
		insertQueue.run("https://primer.style/product/button?view=1", "primer", "2026-10-30T00:00:00.000Z");
		insertQueue.run("https://primer.style/view-components/lookbook/preview/button", "primer", "2026-10-30T00:00:02.000Z");
		insertQueue.run("https://design-system.service.gov.uk/components/button/", "govuk", "2026-10-30T00:00:03.000Z");
		insertQueue.run("https://designsystem.digital.gov/components/button", "uswds", "2026-10-30T00:00:04.000Z");
		db.prepare("INSERT INTO queue (url, system_id, enqueued_at, op) VALUES (?, ?, ?, 'seen')").run(
			"https://primer.style/product/button",
			"primer",
			"2026-10-29T00:00:00.000Z",
		);
		db.prepare("INSERT INTO discover_frontier (system_id, url) VALUES (?, ?)").run(
			"primer",
			"https://primer.style/octicons/icon/star-fill-16/",
		);
		db.prepare("INSERT INTO discover_frontier (system_id, url) VALUES (?, ?)").run(
			"primer",
			"https://primer.style/brand/visual-assets/",
		);
		db.prepare("INSERT INTO discover_url (system_id, url) VALUES (?, ?)").run("govuk", "https://design-system.service.gov.uk/styles/");
		db.exec(readFileSync(join(root, "migrations", canon), "utf8"));
		const pages = db.prepare("SELECT system_id, url, kind, status, enqueued_at FROM page_work ORDER BY system_id, url").all() as Array<{
			system_id: string;
			url: string;
			kind: string;
			status: string;
			enqueued_at: string;
		}>;
		expect(pages).toEqual([
			{
				system_id: "govuk",
				url: "https://design-system.service.gov.uk/components/button",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-10-04T00:00:00.000Z",
			},
			{
				system_id: "primer",
				url: "https://primer.style/Product/Button",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-10-01T00:00:00.000Z",
			},
			{
				system_id: "primer",
				url: "https://primer.style/brand/logo",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-09-02T00:00:00.000Z",
			},
			{
				system_id: "primer",
				url: "https://primer.style/foundations/icons",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-09-01T00:00:00.000Z",
			},
			{
				system_id: "primer",
				url: "https://primer.style/product/button",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-10-02T00:00:00.000Z",
			},
			{
				system_id: "primer",
				url: "https://primer.style/view-components/Lookbook/inspect",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-09-03T00:00:00.000Z",
			},
			{
				system_id: "uswds",
				url: "https://designsystem.digital.gov/components/button",
				kind: "seed",
				status: "done",
				enqueued_at: "2026-10-06T00:00:00.000Z",
			},
		]);
		const queued = db.prepare("SELECT system_id, url, enqueued_at, op FROM queue ORDER BY system_id, url").all();
		expect(queued).toEqual([
			{
				system_id: "govuk",
				url: "https://design-system.service.gov.uk/components/button",
				enqueued_at: "2026-10-30T00:00:03.000Z",
				op: "fetch",
			},
			{
				system_id: "primer",
				url: "https://primer.style/product/button",
				enqueued_at: "2026-10-30T00:00:00.000Z",
				op: "fetch",
			},
			{
				system_id: "uswds",
				url: "https://designsystem.digital.gov/components/button",
				enqueued_at: "2026-10-30T00:00:04.000Z",
				op: "fetch",
			},
		]);
		const frontier = db.prepare("SELECT url FROM discover_frontier ORDER BY url").all() as Array<{ url: string }>;
		expect(frontier.map((row) => row.url)).toEqual(["https://primer.style/brand/visual-assets"]);
		const govukDiscover = db.prepare("SELECT url FROM discover_url").all() as Array<{ url: string }>;
		expect(govukDiscover.map((row) => row.url)).toEqual(["https://design-system.service.gov.uk/styles"]);
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
