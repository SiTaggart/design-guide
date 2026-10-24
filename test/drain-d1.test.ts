import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { D1_STEP_RETRIES } from "../src/index/d1-step.ts";
import { fillTick } from "../src/index/fill.ts";
import { writeIndexedHash } from "../src/index/indexed-hashes.ts";
import { D1PageQueue, FILL_LEASE_STALE_MS } from "../src/index/page-queue.ts";
import { systemSeedHash } from "../src/index/seed-hash.ts";
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
		if (claimLeft > 0 && /INSERT INTO page_work/i.test(sql)) {
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
		expect(calls).toHaveLength(4);
		expect(new Set(calls).size).toBe(1);
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
		const queue = new D1PageQueue(commitThenThrow(db, /INSERT INTO page_work/i), {
			retries: D1_STEP_RETRIES,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const claimed = await queue.claim(10, NOW);
		expect(claimed.map((item) => item.url)).toEqual([PAGE]);
		expect(claimed[0]?.attempts).toBe(1);
		expect(sleeps).toEqual([10_000]);
		const row = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number }>();
		expect(row).toEqual({ status: "claimed", attempts: 1 });
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

	it("claimFillLease blocks a second owner until release, and a stale lease can be taken", async () => {
		const queue = new D1PageQueue(memoryD1());
		expect(await queue.claimFillLease("owner-a", NOW)).toBe(true);
		expect(await queue.claimFillLease("owner-b", NOW)).toBe(false);
		await queue.releaseFillLease("owner-a");
		expect(await queue.claimFillLease("owner-b", NOW)).toBe(true);
		const later = new Date(Date.parse(NOW) + FILL_LEASE_STALE_MS + 1000).toISOString();
		expect(await queue.claimFillLease("owner-c", later)).toBe(true);
	});

	it("claimFillLease blocks a second tick while the first is sleeping", async () => {
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
		releaseSleep();
		await first;
		expect(sent).toEqual([]);
		const row = await db
			.prepare("SELECT status, attempts FROM page_work WHERE url = ?")
			.bind(PAGE)
			.first<{ status: string; attempts: number }>();
		expect(row).toEqual({ status: "done", attempts: 1 });
	});
});
