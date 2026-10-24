import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { createD1TickBudget, D1_STEP_RETRIES } from "../src/index/d1-step.ts";
import { drainTick } from "../src/index/drain.ts";
import { fillTick, noteIndexedSeeds } from "../src/index/fill.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { D1PageQueue, FILL_LEASE_STALE_MS, FILL_LEASE_WINDOW, FILL_TICK_DEADLINE_MS } from "../src/index/page-queue.ts";
import { seedHashKey, systemSeedHash } from "../src/index/seed-hash.ts";
import { PARKS_KEY } from "../src/index/parks.ts";
import { LAST_INDEXED_HASH_KEY, STATUS_KEY } from "../src/index/status.ts";
import { DRIFT_CRON } from "../src/index/trigger.ts";
import * as itemsRest from "../src/index/items-rest.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-10-24T12:00:53.053Z";
const OLD = "2026-09-01T00:00:00.000Z";
const PAGE = "https://primer.style/components/button";
const REMOVED = "https://primer.style/components/removed";
const TRANSIENT = "D1_EXEC_ERROR: Internal error while starting up D1 DB storage caused object to be reset";
const SQL_ERROR = "D1_ERROR: UNIQUE constraint failed: page_work.system_id, page_work.url";
const MISSING_BINDING = "PAGE_QUEUE binding is missing";

type FailMode = "claim-once" | "always" | "sql-once";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function flake(db: D1Database, mode: FailMode, calls: string[]): D1Database {
	let claimLeft = mode === "claim-once" ? 1 : 0;
	let sqlLeft = mode === "sql-once" ? 1 : 0;
	const fail = (sql: string): Error | null => {
		if (mode === "always") {
			return new Error(TRANSIENT);
		}
		if (claimLeft > 0 && /claim_token/i.test(sql)) {
			claimLeft -= 1;
			return new Error(TRANSIENT);
		}
		if (sqlLeft > 0) {
			sqlLeft -= 1;
			return new Error(SQL_ERROR);
		}
		return null;
	};
	const layer = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const gate = async <T>(op: () => Promise<T>): Promise<T> => {
			calls.push(sql);
			const error = fail(sql);
			if (error) {
				throw error;
			}
			return op();
		};
		const bind = (...params: unknown[]) => stmt.bind(...(params as Parameters<D1PreparedStatement["bind"]>));
		const all = (...args: unknown[]) => stmt.all(...(args as Parameters<D1PreparedStatement["all"]>));
		const run = (...args: unknown[]) => stmt.run(...(args as Parameters<D1PreparedStatement["run"]>));
		const first = (...args: unknown[]) => stmt.first(...(args as Parameters<D1PreparedStatement["first"]>));
		return {
			bind: (...params: unknown[]) => layer(bind(...params), sql),
			all: (...args: unknown[]) => gate(() => all(...args)),
			run: (...args: unknown[]) => gate(() => run(...args)),
			first: (...args: unknown[]) => gate(() => first(...args)),
		} as D1PreparedStatement;
	};
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") {
				return Reflect.get(target, prop, receiver);
			}
			return (sql: string) => layer(target.prepare(sql), sql);
		},
	}) as D1Database;
}

function throwingDatabase(message: string, calls: string[]): D1Database {
	const db = memoryD1();
	const layer = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const gate = async <T>(): Promise<T> => {
			calls.push(sql);
			throw new Error(message);
		};
		return {
			bind: (...params: unknown[]) => layer(stmt.bind(...params), sql),
			all: () => gate(),
			run: () => gate(),
			first: () => gate(),
		} as D1PreparedStatement;
	};
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") {
				return Reflect.get(target, prop, receiver);
			}
			return (sql: string) => layer(target.prepare(sql), sql);
		},
	}) as D1Database;
}

function wrapStatement(
	db: D1Database,
	gate: (sql: string, op: () => Promise<unknown>) => Promise<unknown>,
): D1Database {
	const layer = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const bind = (...params: unknown[]) => stmt.bind(...(params as Parameters<D1PreparedStatement["bind"]>));
		const all = (...args: unknown[]) => stmt.all(...(args as Parameters<D1PreparedStatement["all"]>));
		const run = (...args: unknown[]) => stmt.run(...(args as Parameters<D1PreparedStatement["run"]>));
		const first = (...args: unknown[]) => stmt.first(...(args as Parameters<D1PreparedStatement["first"]>));
		return {
			bind: (...params: unknown[]) => layer(bind(...params), sql),
			all: (...args: unknown[]) => gate(sql, () => all(...args)),
			run: (...args: unknown[]) => gate(sql, () => run(...args)),
			first: (...args: unknown[]) => gate(sql, () => first(...args)),
		} as D1PreparedStatement;
	};
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== "prepare") {
				return Reflect.get(target, prop, receiver);
			}
			return (sql: string) => layer(target.prepare(sql), sql);
		},
	}) as D1Database;
}

function commitThenThrow(db: D1Database, pattern: RegExp): D1Database {
	let left = 1;
	return wrapStatement(db, async (sql, op) => {
		const matched = left > 0 && pattern.test(sql);
		if (matched) {
			left -= 1;
		}
		const result = await op();
		if (matched) {
			throw new Error(TRANSIENT);
		}
		return result;
	});
}

function failSelectOnce(db: D1Database): D1Database {
	let left = 1;
	return wrapStatement(db, async (sql, op) => {
		if (left > 0 && /^\s*SELECT\b/i.test(sql)) {
			left -= 1;
			throw new Error(TRANSIENT);
		}
		return op();
	});
}

function recordStatements(db: D1Database, calls: string[]): D1Database {
	return wrapStatement(db, async (sql, op) => {
		calls.push(sql);
		return op();
	});
}

async function settle(env: Parameters<typeof writeIndexedHash>[0], queue: D1PageQueue): Promise<void> {
	for (const id of SYSTEM_IDS) {
		await writeIndexedHash(env, id, systemSeedHash(seedById(id)));
		await queue.markDiscovered(id, NOW);
	}
}

async function indexed(queue: D1PageQueue, url: string, at: string): Promise<void> {
	await queue.enqueueUpsert([{ systemId: "primer", url, kind: "reindex" }], at);
	await queue.complete({ systemId: "primer", url }, { lastCrawled: at, lastIndexed: at }, "primer/page/old.md");
}

function mockIndex(): { sent: Array<{ subject?: string; text?: string }>; deleted: ReturnType<typeof vi.fn> } {
	const sent: Array<{ subject?: string; text?: string }> = [];
	vi.spyOn(itemsRest, "ensureInstance").mockResolvedValue();
	vi.spyOn(itemsRest, "uploadItem").mockResolvedValue({ id: "fresh", key: "primer/page/fresh.md" });
	vi.spyOn(itemsRest, "listItems").mockResolvedValue([]);
	const deleted = vi.fn(async () => undefined);
	vi.spyOn(itemsRest, "deleteItem").mockImplementation(deleted);
	vi.spyOn(itemsRest, "deleteItemByKey").mockImplementation(deleted);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json({ result: "# button" })),
	);
	return { sent, deleted };
}

async function runTick(mode: FailMode): Promise<{
	db: D1Database;
	kv: ReturnType<typeof memoryKV>;
	calls: string[];
	sleeps: number[];
	sent: Array<{ subject?: string; text?: string }>;
	deleted: ReturnType<typeof vi.fn>;
}> {
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	const kv = memoryKV();
	await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
	const { env } = envWithIndex([], true, {
		INDEX: kv,
		PAGE_QUEUE: db,
		CLOUDFLARE_ACCOUNT_ID: "acct",
		CLOUDFLARE_API_TOKEN: "token",
	});
	await settle(env, queue);
	const { sent, deleted } = mockIndex();
	env.EMAIL = {
		send: async (message) => {
			sent.push(message as { subject?: string; text?: string });
			return { messageId: "m" };
		},
	};
	const calls: string[] = [];
	const sleeps: number[] = [];
	env.PAGE_QUEUE = flake(db, mode, calls);
	await fillTick(env, DRIFT_CRON, new Date(NOW), {}, { sleep: async (ms) => { sleeps.push(ms); } });
	return { db, kv, calls, sleeps, sent, deleted };
}

describe("drain D1 steps", () => {
	it("finishes the run after one transient D1 error and does not send fail mail", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		const calls: string[] = [];
		const sleeps: number[] = [];
		env.PAGE_QUEUE = flake(db, "claim-once", calls);
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, { sleep: async (ms) => { sleeps.push(ms); } });
		expect(sleeps).toEqual([10_000]);
		expect(sent).toEqual([]);
		expect(JSON.parse(kv.store.get(STATUS_KEY) ?? "{}")).toMatchObject({ state: "ok" });
		const row = await db
			.prepare("SELECT status, attempts, last_indexed FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number; last_indexed: string }>();
		expect(row).toEqual({ status: "done", attempts: 1, last_indexed: NOW });
	});

	it("sends one fail mail after transient D1 errors exhaust the retries", async () => {
		const { calls, sleeps, sent } = await runTick("always");
		expect(calls).toHaveLength(5);
		expect(new Set(calls.slice(0, 4)).size).toBe(1);
		expect(calls[0]).toContain("INSERT INTO fill_lease");
		expect(calls[4]).toContain("DELETE FROM fill_lease");
		expect(sleeps).toEqual([10_000, 20_000, 40_000]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.subject).toContain("fail");
		expect(sent[0]?.text).toContain(TRANSIENT);
	});

	it("fails a non-transient SQL error on the first attempt", async () => {
		const { calls, sleeps, sent } = await runTick("sql-once");
		expect(sleeps).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.subject).toContain("fail");
		expect(sent[0]?.text).toContain(SQL_ERROR);

		const directCalls: string[] = [];
		const directSleeps: number[] = [];
		const queue = new D1PageQueue(throwingDatabase(SQL_ERROR, directCalls), {
			retries: D1_STEP_RETRIES,
			sleep: async (ms) => {
				directSleeps.push(ms);
			},
		});
		const error = await queue.running().then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(NonRetryableError);
		expect(error).toMatchObject({ message: SQL_ERROR });
		expect(directCalls).toHaveLength(1);
		expect(directSleeps).toEqual([]);
	});

	it("fails a missing binding on the first attempt", async () => {
		const calls: string[] = [];
		const sleeps: number[] = [];
		const queue = new D1PageQueue(throwingDatabase(MISSING_BINDING, calls), {
			retries: D1_STEP_RETRIES,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const error = await queue.depths().then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(NonRetryableError);
		expect(error).toMatchObject({ message: MISSING_BINDING });
		expect(calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it("does not prune or move lastIndexed when the run fails", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await indexed(queue, PAGE, OLD);
		await indexed(queue, REMOVED, OLD);
		const { sent, deleted } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		const calls: string[] = [];
		env.PAGE_QUEUE = flake(db, "always", calls);
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, { sleep: async () => undefined });
		expect(sent).toHaveLength(1);
		expect(deleted).not.toHaveBeenCalled();
		expect(kv.store.get(LAST_INDEXED_HASH_KEY)).toBe("keep-me");
		const rows = await db
			.prepare("SELECT url, last_indexed FROM page_work ORDER BY url ASC")
			.all<{ url: string; last_indexed: string }>();
		expect(rows.results).toEqual([
			{ url: PAGE, last_indexed: OLD },
			{ url: REMOVED, last_indexed: OLD },
		]);
	});

	it("keeps one row and one attempt when enqueue and claim run twice", async () => {
		const queue = new D1PageQueue(memoryD1());
		const item = { systemId: "primer" as const, url: PAGE, kind: "reindex" as const };
		await queue.enqueueUpsert([item], OLD);
		await queue.enqueueUpsert([item], NOW);
		const first = await queue.claim(10, NOW);
		const second = await queue.claim(10, NOW);
		expect(first.map((claimed) => claimed.url)).toEqual([PAGE]);
		expect(first[0]?.attempts).toBe(1);
		expect(second).toEqual([]);
		const row = await (queue as unknown as { db: D1Database }).db
			.prepare("SELECT COUNT(*) AS n, MAX(attempts) AS attempts FROM page_work")
			.first<{ n: number; attempts: number }>();
		expect(row).toEqual({ n: 1, attempts: 1 });
	});

	it("retries a committed claim without counting a second attempt", async () => {
		const db = memoryD1();
		const setup = new D1PageQueue(db);
		await setup.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const sleeps: number[] = [];
		const queue = new D1PageQueue(commitThenThrow(db, /claim_token/i), {
			retries: D1_STEP_RETRIES,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const claimed = await queue.claim(10, NOW);
		const owned = claimed[0];
		expect(claimed.map((item) => item.url)).toEqual([PAGE]);
		expect(owned?.attempts).toBe(1);
		expect(owned?.claimedAt).toBe(NOW);
		expect(owned?.claimToken).toBeTruthy();
		expect(owned?.claimToken).not.toBe(NOW);
		expect(await queue.owns(owned!)).toBe(true);
		expect(sleeps).toEqual([10_000]);
		const row = await db
			.prepare("SELECT status, attempts, claimed_at, claim_token FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number; claimed_at: string; claim_token: string }>();
		expect(row).toEqual({
			status: "claimed",
			attempts: 1,
			claimed_at: NOW,
			claim_token: owned?.claimToken,
		});
	});

	it("does not let two claims at the same now both own a row", async () => {
		const queue = new D1PageQueue(memoryD1());
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const first = await queue.claim(10, NOW);
		const second = await queue.claim(10, NOW);
		const owned = first[0];
		expect(second).toEqual([]);
		expect(owned?.claimedAt).toBe(NOW);
		expect(owned?.claimToken).toBeTruthy();
		expect(await queue.owns(owned!)).toBe(true);
		expect(await queue.owns({ ...owned!, claimToken: crypto.randomUUID() })).toBe(false);
		const row = await (queue as unknown as { db: D1Database }).db
			.prepare("SELECT attempts, claim_token FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ attempts: number; claim_token: string }>();
		expect(row).toEqual({ attempts: 1, claim_token: owned?.claimToken });
	});

	it("does not recreate a deleted row, including when the claim is retried", async () => {
		const db = memoryD1();
		const setup = new D1PageQueue(db);
		await setup.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		await db.prepare("DELETE FROM page_work WHERE url = ?").bind(PAGE).run();
		const absent = new D1PageQueue(db);
		expect(await absent.claim(10, NOW)).toEqual([]);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM page_work").first<{ n: number }>())?.n).toBe(0);

		await setup.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		let drop = true;
		const queue = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				if (drop && /claim_token/i.test(sql)) {
					drop = false;
					await db.prepare("DELETE FROM page_work WHERE url = ?").bind(PAGE).run();
					await op();
					throw new Error(TRANSIENT);
				}
				return op();
			}),
			{
				retries: D1_STEP_RETRIES,
				sleep: async () => undefined,
			},
		);
		expect(await queue.claim(10, NOW)).toEqual([]);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM page_work").first<{ n: number }>())?.n).toBe(0);
	});

	it("spends one retry schedule across statements", async () => {
		const db = memoryD1();
		const sleeps: number[] = [];
		let failNext = true;
		const queue = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				if (failNext && /^\s*select\b/i.test(sql)) {
					failNext = false;
					throw new Error(TRANSIENT);
				}
				return op();
			}),
			{
				retries: D1_STEP_RETRIES,
				budget: createD1TickBudget(),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		await queue.depths();
		failNext = true;
		await queue.depths();
		expect(sleeps).toEqual([10_000, 20_000]);
	});

	it("does not retry a poll-failure counter after the write commits", async () => {
		const db = memoryD1();
		const setup = new D1PageQueue(db);
		await setup.insertRun({
			systemId: "primer",
			kind: "reindex",
			trigger: "recrawl",
			jobId: "job",
			startUrl: PAGE,
			cursor: null,
			pollFailures: 0,
			startedAt: OLD,
			now: OLD,
		});
		const sleeps: number[] = [];
		const queue = new D1PageQueue(commitThenThrow(db, /poll_failures = poll_failures \+ 1/), {
			retries: D1_STEP_RETRIES,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await expect(queue.notePollFailure("primer", NOW)).rejects.toThrow(TRANSIENT);
		expect(sleeps).toEqual([]);
		const row = await db.prepare("SELECT poll_failures FROM discover_run").first<{ poll_failures: number }>();
		expect(row?.poll_failures).toBe(1);
	});

	it("keeps the fill lease past a full tick and inside the next cron", () => {
		const window = FILL_LEASE_WINDOW;
		expect(window.tickDeadlineMs + window.maxBackoffMs + window.marginMs).toBeLessThan(window.ttlMs);
		expect(window.ttlMs).toBeLessThan(5 * 60 * 1000);
		expect(window.ttlMs).toBe(FILL_LEASE_STALE_MS);
		expect(window.ttlMs).toBeLessThan(window.cronIntervalMs);
		expect(window.maxBackoffMs).toBe(40_000);
	});

	it("a different claim token with the same attempts and claimed_at leaves the row unchanged", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const timestamps = { lastCrawled: NOW, lastIndexed: NOW };
		const held = async (url: string, attempts = 2) => {
			await db
				.prepare(
					`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts, claimed_at, claim_token)
					 VALUES ('primer', ?, 'reindex', 'claimed', ?, ?, ?, 'holder-token')`,
				)
				.bind(url, OLD, attempts, NOW)
				.run();
			return {
				systemId: "primer" as const,
				url,
				attempts,
				claimedAt: NOW,
				claimToken: "other-token",
			};
		};
		const unchanged = {
			status: "claimed",
			attempts: 2,
			claimed_at: NOW,
			claim_token: "holder-token",
			error: null,
			item_key: null,
			last_indexed: null,
		};
		const read = (url: string) =>
			db
				.prepare(
					`SELECT status, attempts, claimed_at, claim_token, error, item_key, last_indexed
					 FROM page_work WHERE url = ?`,
				)
				.bind(url)
				.first<{
					status: string;
					attempts: number;
					claimed_at: string;
					claim_token: string;
					error: string | null;
					item_key: string | null;
					last_indexed: string | null;
				}>();

		const completeUrl = "https://primer.style/components/action-list";
		const keepUrl = "https://primer.style/components/avatar";
		const failUrl = "https://primer.style/components/blankslate";
		const retryUrl = "https://primer.style/components/breadcrumbs";
		expect(await queue.complete(await held(completeUrl), timestamps, "primer/page/complete.md")).toBe(false);
		expect(await queue.complete(await held(keepUrl), timestamps, "primer/page/keep.md", { keepIndexedAt: true })).toBe(
			false,
		);
		expect(await queue.fail(await held(failUrl), "nope")).toBe(false);
		expect(await queue.releaseForRetry(await held(retryUrl), "primer/page/retry.md")).toBe(false);
		expect(await read(completeUrl)).toEqual(unchanged);
		expect(await read(keepUrl)).toEqual(unchanged);
		expect(await read(failUrl)).toEqual(unchanged);
		expect(await read(retryUrl)).toEqual(unchanged);

		const holdUrl = `${PAGE}/`;
		await held(holdUrl, 1);
		await db
			.prepare(
				`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts)
				 VALUES ('primer', ?, 'reindex', 'pending', ?, 2)`,
			)
			.bind(PAGE, OLD)
			.run();
		const yielding = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				const result = await op();
				if (/set status = 'claimed'/i.test(sql)) {
					await db
						.prepare("UPDATE page_work SET claim_token = ? WHERE system_id = ? AND url = ?")
						.bind("other-token", "primer", PAGE)
						.run();
				}
				return result;
			}),
		);
		const returned = await yielding.claim(10, NOW);
		expect(returned.map((item) => item.url)).not.toContain(PAGE);
		expect(await read(PAGE)).toEqual({
			status: "claimed",
			attempts: 3,
			claimed_at: NOW,
			claim_token: "other-token",
			error: null,
			item_key: null,
			last_indexed: null,
		});
		expect(await read(holdUrl)).toEqual({
			status: "claimed",
			attempts: 1,
			claimed_at: NOW,
			claim_token: "holder-token",
			error: null,
			item_key: null,
			last_indexed: null,
		});
	});

	it("counts a complete that commits and then reports a transient error", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const [item] = await queue.claim(1, NOW);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((message) => {
			logs.push(String(message));
		});
		const wrapped = new D1PageQueue(commitThenThrow(db, /set status = 'done'/i), {
			retries: D1_STEP_RETRIES,
			sleep: async () => undefined,
		});
		expect(await wrapped.complete(item!, { lastCrawled: NOW, lastIndexed: NOW }, "primer/page.md")).toBe(true);
		expect(logs.some((line) => line.includes("page_claim_lost"))).toBe(false);
		expect(
			await db
				.prepare("SELECT status, claim_token FROM page_work WHERE url = ?")
				.bind(PAGE)
				.first<{ status: string; claim_token: string | null }>(),
		).toEqual({ status: "done", claim_token: null });
	});

	it("a tick that reaches the deadline mid-drain does no further D1 writes and releases the lease", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		let clock = Date.now();
		const started = clock;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				clock = started + FILL_TICK_DEADLINE_MS;
				return json({ result: "# button" });
			}),
		);
		const calls: string[] = [];
		const lateWrites: string[] = [];
		const sleeps: number[] = [];
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			calls.push(sql);
			const writing = /^\s*(insert|update|delete)\b/i.test(sql);
			const release =
				/delete\s+from\s+fill_lease/i.test(sql) ||
				(/status = 'pending'/i.test(sql) && /claim_token = \?/i.test(sql));
			if (writing && clock >= started + FILL_TICK_DEADLINE_MS && !release) {
				lateWrites.push(sql);
				throw new Error(TRANSIENT);
			}
			return op();
		});
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(lateWrites).toEqual([]);
		expect(sleeps).toEqual([]);
		expect(calls.filter((sql) => /delete\s+from\s+fill_lease/i.test(sql))).toHaveLength(1);
		expect(sent).toEqual([]);
		const row = await db
			.prepare("SELECT status, attempts, claim_token FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number; claim_token: string | null }>();
		expect(row).toEqual({ status: "pending", attempts: 0, claim_token: null });
		expect((await db.prepare("SELECT COUNT(*) AS n FROM fill_lease").first<{ n: number }>())?.n).toBe(0);
		expect(await new D1PageQueue(db).claimFillLease(crypto.randomUUID(), NOW)).toBe(true);
	});

	it("a deadline stop returns unstarted pages and leaves a re-claimed page alone", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		const other = "https://primer.style/components/action-list";
		await queue.enqueueUpsert(
			[
				{ systemId: "primer", url: PAGE, kind: "reindex" },
				{ systemId: "primer", url: other, kind: "reindex" },
			],
			OLD,
		);
		let clock = Date.now();
		const started = clock;
		let armed = false;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (!armed) {
					armed = true;
					clock = started + FILL_TICK_DEADLINE_MS;
					await db
						.prepare("UPDATE page_work SET claim_token = ? WHERE url = ?")
						.bind("other-owner", PAGE)
						.run();
				}
				return json({ result: "# button" });
			}),
		);
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async () => {
				throw new Error("slept after the deadline");
			},
		});
		expect(armed).toBe(true);
		expect(
			await db
				.prepare("SELECT status, attempts, claim_token FROM page_work WHERE url = ?")
				.bind(other)
				.first<{ status: string; attempts: number; claim_token: string | null }>(),
		).toEqual({ status: "pending", attempts: 0, claim_token: null });
		expect(
			await db
				.prepare("SELECT status, attempts, claim_token FROM page_work WHERE url = ?")
				.bind(PAGE)
				.first<{ status: string; attempts: number; claim_token: string | null }>(),
		).toEqual({ status: "claimed", attempts: 1, claim_token: "other-owner" });
		expect((await db.prepare("SELECT COUNT(*) AS n FROM fill_lease").first<{ n: number }>())?.n).toBe(0);
	});

	it("an exhausted drain returns claimed pages to pending with attempts unchanged", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		let claimed = false;
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			const release =
				/delete\s+from\s+fill_lease/i.test(sql) ||
				(/status = 'pending'/i.test(sql) && /claim_token = \?/i.test(sql));
			if (claimed && !release) {
				throw new Error(TRANSIENT);
			}
			const result = await op();
			if (/set status = 'claimed'/i.test(sql)) {
				claimed = true;
			}
			return result;
		});
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async () => undefined,
		});
		expect(claimed).toBe(true);
		expect(
			await db
				.prepare("SELECT status, attempts, claim_token FROM page_work WHERE url = ?")
				.bind(PAGE)
				.first<{ status: string; attempts: number; claim_token: string | null }>(),
		).toEqual({ status: "pending", attempts: 0, claim_token: null });
		expect((await db.prepare("SELECT COUNT(*) AS n FROM fill_lease").first<{ n: number }>())?.n).toBe(0);
		expect(await new D1PageQueue(db).claimFillLease(crypto.randomUUID(), NOW)).toBe(true);
	});

	it("a deadline during post-drain writes no failed status and sends no fail mail", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		const status = JSON.stringify({ state: "ok", systems: [], parks: {} });
		await kv.put(STATUS_KEY, status);
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		let clock = Date.now();
		const started = clock;
		let drained = false;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			const result = await op();
			if (/with served\b/i.test(sql)) {
				drained = true;
				clock = started + FILL_TICK_DEADLINE_MS;
			}
			return result;
		});
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async () => {
				throw new Error("slept after the drain");
			},
		});
		expect(drained).toBe(true);
		expect(sent).toEqual([]);
		expect(JSON.parse(kv.store.get(STATUS_KEY) ?? "{}")).toMatchObject({ state: "ok" });
		expect(kv.store.get(LAST_INDEXED_HASH_KEY)).toBe("keep-me");
		expect((await db.prepare("SELECT COUNT(*) AS n FROM fill_lease").first<{ n: number }>())?.n).toBe(0);
		expect(await new D1PageQueue(db).claimFillLease(crypto.randomUUID(), NOW)).toBe(true);
	});

	it("a tick that hits the deadline leaves a healthy system unchanged", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		const status = JSON.stringify({ state: "ok", systems: [], parks: {} });
		await kv.put(STATUS_KEY, status);
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.insertRun({
			systemId: "primer",
			kind: "reindex",
			trigger: "recrawl",
			jobId: "job-healthy",
			startUrl: PAGE,
			cursor: "done",
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await queue.stageUrl("primer", PAGE);
		await queue.stageIndexable("primer", PAGE);
		await queue.stageIndexable("primer", "https://primer.style/components/action-list");
		const before = new Map(kv.store);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		let clock = Date.now();
		const started = clock;
		let sawRun = false;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			if (/from discover_run/i.test(sql) && /^\s*select\b/i.test(sql)) {
				sawRun = true;
			} else if (sawRun && /^\s*select\b/i.test(sql)) {
				clock = started + FILL_TICK_DEADLINE_MS;
			}
			return op();
		});
		await fillTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => {
				clock = started + FILL_TICK_DEADLINE_MS;
				return { status: "completed", finished: 2, total: 2 };
			},
			page: async () => ({ records: [], cursor: null }),
			start: async () => {
				throw new Error("started after the deadline");
			},
			cancel: async () => undefined,
		});
		expect(sawRun).toBe(true);
		expect(sent).toEqual([]);
		expect(kv.store.get(STATUS_KEY)).toBe(before.get(STATUS_KEY));
		expect(kv.store.get(LAST_INDEXED_HASH_KEY)).toBe("keep-me");
		expect(kv.store.get(PARKS_KEY) ?? null).toBe(before.get(PARKS_KEY) ?? null);
		const run = await db
			.prepare("SELECT job_id FROM discover_run WHERE system_id = 'primer'")
			.first<{ job_id: string }>();
		expect(run).toEqual({ job_id: "job-healthy" });
		const pages = await db
			.prepare("SELECT COUNT(*) AS n FROM discover_indexable WHERE system_id = 'primer'")
			.first<{ n: number }>();
		expect(pages?.n).toBe(2);
	});

	it("an exhausted tick does not read D1 while sending mail", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.insertRun({
			systemId: "primer",
			kind: "reindex",
			trigger: "recrawl",
			jobId: "job-mail",
			startUrl: PAGE,
			cursor: "done",
			pollFailures: 0,
			startedAt: NOW,
			now: NOW,
		});
		await queue.stageUrl("primer", PAGE);
		await queue.stageIndexable("primer", PAGE);
		await queue.stageIndexable("primer", "https://primer.style/components/action-list");
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		let armed = false;
		let failures = 0;
		const readsAfterExhaust: string[] = [];
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			if (/delete from discover_run/i.test(sql)) {
				const result = await op();
				armed = true;
				return result;
			}
			const writing = /^\s*(insert|update|delete)\b/i.test(sql);
			if (armed && writing && !/delete\s+from\s+fill_lease/i.test(sql)) {
				failures += 1;
				throw new Error(TRANSIENT);
			}
			if (failures >= 4 && /^\s*select\b/i.test(sql)) {
				readsAfterExhaust.push(sql);
			}
			return op();
		});
		const sleeps: number[] = [];
		await fillTick(env, DRIFT_CRON, new Date(NOW), {
			poll: async () => ({ status: "completed", finished: 2, total: 2 }),
			page: async () => ({ records: [], cursor: null }),
			start: async () => {
				throw new Error("started during mail");
			},
			cancel: async () => undefined,
		}, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(failures).toBe(4);
		expect(sleeps).toEqual([10_000, 20_000, 40_000]);
		expect(readsAfterExhaust).toEqual([]);
		expect(sent.some((message) => message.text?.includes(TRANSIENT))).toBe(true);
	});

	it("a late tick cannot change a page or lease held by the next owner", async () => {
		const db = memoryD1();
		const ownerA = crypto.randomUUID();
		const first = new D1PageQueue(db);
		expect(await first.claimFillLease(ownerA, NOW)).toBe(true);
		await first.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const claimed = await first.claim(10, NOW);
		const item = claimed[0];
		expect(item?.claimToken).toBeTruthy();

		const takeover = new Date(Date.parse(NOW) + 15 * 60 * 1000 + 1000).toISOString();
		const ownerB = crypto.randomUUID();
		const second = new D1PageQueue(db);
		expect(await second.claimFillLease(ownerB, takeover)).toBe(true);
		const reclaimed = await second.claim(10, takeover);
		expect(reclaimed[0]?.claimToken).toBeTruthy();
		expect(reclaimed[0]?.claimToken).not.toBe(item?.claimToken);

		const effects: Array<{ sql: string; changes: number }> = [];
		const late = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				const result = (await op()) as { meta?: { changes?: number } };
				if (result?.meta?.changes !== undefined) {
					effects.push({ sql, changes: result.meta.changes });
				}
				return result;
			}),
		);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((message) => {
			logs.push(String(message));
		});
		expect(await late.complete(item!, { lastCrawled: NOW, lastIndexed: NOW }, "primer/page/late.md")).toBe(false);
		expect(await late.fail(item!, "late")).toBe(false);
		expect(await late.releaseForRetry(item!, "primer/page/late.md")).toBe(false);
		await late.releaseFillLease(ownerA);

		expect(effects.length).toBeGreaterThanOrEqual(4);
		expect(effects.every((effect) => effect.changes === 0)).toBe(true);
		expect(effects.some((effect) => /claim_token/i.test(effect.sql))).toBe(true);
		expect(effects.some((effect) => /delete\s+from\s+fill_lease/i.test(effect.sql) && /owner/i.test(effect.sql))).toBe(
			true,
		);
		expect(logs.some((line) => line.includes("page_claim_lost"))).toBe(true);
		expect(logs.some((line) => line.includes('"event":"index_mail_failed"'))).toBe(false);

		const row = await db
			.prepare("SELECT status, attempts, claim_token FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number; claim_token: string }>();
		expect(row).toEqual({
			status: "claimed",
			attempts: reclaimed[0]?.attempts,
			claim_token: reclaimed[0]?.claimToken,
		});
		const lease = await db
			.prepare("SELECT owner, claimed_at FROM fill_lease WHERE id = 'fill'")
			.first<{ owner: string; claimed_at: string }>();
		expect(lease).toEqual({ owner: ownerB, claimed_at: takeover });
	});

	it("releases the fill lease after the retry budget is exhausted so the next tick can claim it", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		const calls: string[] = [];
		const sleeps: number[] = [];
		let leased = false;
		env.PAGE_QUEUE = wrapStatement(db, async (sql, op) => {
			calls.push(sql);
			if (/INSERT INTO fill_lease/i.test(sql)) {
				leased = true;
				return op();
			}
			if (/DELETE FROM fill_lease/i.test(sql)) {
				return op();
			}
			if (leased) {
				throw new Error(TRANSIENT);
			}
			return op();
		});
		await fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sleeps).toEqual([10_000, 20_000, 40_000]);
		expect(calls.filter((sql) => /DELETE FROM fill_lease/i.test(sql))).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM fill_lease").first<{ n: number }>())?.n).toBe(0);
		expect(await new D1PageQueue(db).claimFillLease(crypto.randomUUID(), NOW)).toBe(true);
	});

	it("claimFillLease blocks a second owner until release, and a stale lease can be taken", async () => {
		const queue = new D1PageQueue(memoryD1());
		expect(await queue.claimFillLease("owner-a", NOW)).toBe(true);
		expect(await queue.claimFillLease("owner-b", NOW)).toBe(false);
		await queue.releaseFillLease("owner-a");
		expect(await queue.claimFillLease("owner-b", NOW)).toBe(true);
		const later = new Date(Date.parse(NOW) + FILL_LEASE_STALE_MS + 1000).toISOString();
		expect(await queue.claimFillLease("owner-c", later)).toBe(true);
	});

	it("two ticks starting at the same now cannot both hold the fill lease", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const kv = memoryKV();
		await kv.put(LAST_INDEXED_HASH_KEY, "keep-me");
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await settle(env, queue);
		await queue.enqueueUpsert([{ systemId: "primer", url: PAGE, kind: "reindex" }], OLD);
		const { sent } = mockIndex();
		env.EMAIL = {
			send: async (message) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: "m" };
			},
		};
		env.PAGE_QUEUE = failSelectOnce(db);
		let releaseSleep!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseSleep = resolve;
		});
		let markSleeping!: () => void;
		const sleeping = new Promise<void>((resolve) => {
			markSleeping = resolve;
		});
		const first = fillTick(env, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async () => {
				markSleeping();
				await gate;
			},
		});
		await sleeping;
		const held = await db
			.prepare("SELECT owner, claimed_at FROM fill_lease WHERE id = 'fill'")
			.first<{ owner: string; claimed_at: string }>();
		expect(held?.claimed_at).toBe(NOW);
		expect(held?.owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(held?.owner).not.toBe(NOW);
		const secondCalls: string[] = [];
		const secondSent: Array<{ subject?: string; text?: string }> = [];
		const { env: second } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: recordStatements(db, secondCalls),
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		second.EMAIL = {
			send: async (message) => {
				secondSent.push(message as { subject?: string; text?: string });
				return { messageId: "m2" };
			},
		};
		await fillTick(second, DRIFT_CRON, new Date(NOW), {}, {
			sleep: async () => {
				throw new Error("second tick slept");
			},
		});
		expect(secondSent).toEqual([]);
		expect(secondCalls).toHaveLength(1);
		expect(secondCalls[0]).toContain("fill_lease");
		const still = await db
			.prepare("SELECT owner, claimed_at FROM fill_lease WHERE id = 'fill'")
			.first<{ owner: string; claimed_at: string }>();
		expect(still).toEqual(held);
		releaseSleep();
		await first;
		expect(sent).toEqual([]);
		const row = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number }>();
		expect(row).toEqual({ status: "done", attempts: 1 });
	});

	it("does not count a page another holder already finished", async () => {
		const db = memoryD1();
		const queue = new D1PageQueue(db);
		const doneUrl = "https://primer.style/components/action-list";
		const failUrl = "https://primer.style/components/blankslate";
		await queue.enqueueUpsert(
			[
				{ systemId: "primer", url: doneUrl, kind: "reindex" },
				{ systemId: "primer", url: failUrl, kind: "reindex" },
			],
			OLD,
		);
		const otherKey = "primer/page/other.md";
		const otherError = "other holder";
		const racing = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				if (/set status = 'done'/i.test(sql)) {
					await db
						.prepare(
							`UPDATE page_work
							 SET status = 'done', claim_token = NULL, claimed_at = NULL, item_key = ?, error = NULL
							 WHERE url = ?`,
						)
						.bind(otherKey, doneUrl)
						.run();
				}
				if (/set status = 'failed'/i.test(sql)) {
					await db
						.prepare(
							`UPDATE page_work
							 SET status = 'failed', claim_token = NULL, claimed_at = NULL, error = ?
							 WHERE url = ?`,
						)
						.bind(otherError, failUrl)
						.run();
				}
				return op();
			}),
		);
		mockIndex();
		const counts = await drainTick({
			queue: racing,
			auth: { accountId: "acct", apiToken: "token" },
			now: NOW,
			fetchMarkdown: async (url) => {
				if (url === failUrl) {
					throw new Error("render failed");
				}
				return "# action list";
			},
		});
		expect(counts).toEqual({ claimed: 2, indexed: 0, failed: 0 });
		expect(
			await db
				.prepare("SELECT status, item_key, error FROM page_work WHERE url = ?")
				.bind(doneUrl)
				.first<{ status: string; item_key: string | null; error: string | null }>(),
		).toEqual({ status: "done", item_key: otherKey, error: null });
		expect(
			await db
				.prepare("SELECT status, error FROM page_work WHERE url = ?")
				.bind(failUrl)
				.first<{ status: string; error: string | null }>(),
		).toEqual({ status: "failed", error: otherError });
	});

	it("leaves no indexed hash when markDiscovered fails", async () => {
		const db = memoryD1();
		const pageQueue = new D1PageQueue(db);
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
		});
		const hash = systemSeedHash(seedById("primer"));
		const url = "https://primer.style/components";
		await pageQueue.enqueueUpsert([{ systemId: "primer", url, kind: "seed" }], OLD);
		await pageQueue.complete(
			{ systemId: "primer", url },
			{ lastCrawled: NOW, lastIndexed: NOW },
			"primer/page/components.md",
		);
		await pageQueue.recordSeedRefresh("primer", hash, OLD);
		const failing = new D1PageQueue(
			wrapStatement(db, async (sql, op) => {
				if (/into system_mark/i.test(sql)) {
					throw new Error("discover mark failed");
				}
				return op();
			}),
		);
		await expect(noteIndexedSeeds(env, failing, new Date(NOW))).rejects.toThrow("discover mark failed");
		expect(await kv.get(seedHashKey("primer"))).toBeNull();
		expect(
			await db
				.prepare("SELECT last_discovered FROM system_mark WHERE system_id = ?")
				.bind("primer")
				.first<{ last_discovered: string }>(),
		).toBeNull();
	});
});
