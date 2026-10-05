import { describe, expect, it } from "vitest";
import { SYSTEM_IDS, type SystemId } from "../src/config/types.ts";
import type { WorkerEnv } from "../src/index/ai-search.ts";
import { D1PageQueue, type SystemFreshness } from "../src/index/page-queue.ts";
import { writePark } from "../src/index/parks.ts";
import { emptyStatus, readStatus, writeStatus, type IndexStatusDocument } from "../src/index/status.ts";
import { fillHealthFrom, type FillHealthBody } from "../src/serve/fill-health.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const STATUS_TOKEN = "test-status-token";
const CHECKED = "2026-10-05T16:00:00.000Z";
const STALE = "2026-08-01T00:00:00.000Z";

function authed(url: string, token = STATUS_TOKEN): Request {
	return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

function liveRows(overrides: Partial<Record<SystemId, Partial<SystemFreshness>>> = {}): SystemFreshness[] {
	return SYSTEM_IDS.map((system) => ({
		system,
		lastCrawled: CHECKED,
		lastIndexed: CHECKED,
		lastDiscovered: CHECKED,
		pending: 0,
		claimed: 0,
		failed: 0,
		done: 1,
		...overrides[system],
	}));
}

function overlay(partial: Partial<IndexStatusDocument> = {}): IndexStatusDocument {
	const freshness = partial.freshness ?? liveRows();
	const queue = partial.queue ?? {
		pending: freshness.reduce((sum, row) => sum + row.pending, 0),
		claimed: freshness.reduce((sum, row) => sum + row.claimed, 0),
		failed: freshness.reduce((sum, row) => sum + row.failed, 0),
		done: freshness.reduce((sum, row) => sum + row.done, 0),
	};
	return {
		...emptyStatus(false),
		state: "ok",
		discover: null,
		...partial,
		freshness,
		queue,
	};
}

function systemError(system: SystemId, error: string, parked = false) {
	return {
		system,
		startUrl: `https://example.test/${system}`,
		crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 1 },
		indexed: 0,
		hitLimit: false,
		keptPrevious: true,
		usable: 0,
		error,
		...(parked ? { parked: true as const } : {}),
	};
}

function expectAlarm(body: FillHealthBody, alarms: string[]) {
	const text = JSON.stringify(body);
	expect(text).not.toContain('"fill":"ok"');
	expect(text).toContain('"fill":"alarm"');
	expect(body).toEqual({ fill: "alarm", alarms, checkedAt: CHECKED });
}

describe("fillHealthFrom", () => {
	it("returns a healthy body with the exact fill ok substring", () => {
		const body = fillHealthFrom(overlay(), CHECKED);
		const text = JSON.stringify(body);
		expect(text).toContain('"fill":"ok"');
		expect(body).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });
		expect(Object.keys(body)).toEqual(["fill", "alarms", "checkedAt"]);
	});

	it("alarms fleet_freeze when discover is idle and an Empty seed remains", () => {
		const body = fillHealthFrom(
			overlay({
				freshness: liveRows({
					antd: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
				}),
			}),
			CHECKED,
		);
		expectAlarm(body, ["fleet_freeze"]);
	});

	it("alarms fleet_freeze for a due seed that is not Empty", () => {
		const body = fillHealthFrom(
			overlay({
				freshness: liveRows({
					antd: { lastCrawled: STALE, lastIndexed: STALE, lastDiscovered: STALE },
				}),
			}),
			CHECKED,
		);
		expectAlarm(body, ["fleet_freeze"]);
	});

	it("does not fleet_freeze for Parked stubs, Live idle, or an active discover", () => {
		const parked = fillHealthFrom(
			overlay({
				parks: { garden: { reason: "stub", usable: 1, at: CHECKED } },
				freshness: liveRows({
					garden: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
				}),
				systems: [systemError("garden", "stub: only 1 usable page(s)", true)],
			}),
			CHECKED,
		);
		expect(parked.fill).toBe("ok");

		const discovered = fillHealthFrom(
			overlay({
				freshness: liveRows({
					antd: { lastCrawled: null, lastIndexed: null, lastDiscovered: CHECKED, done: 0 },
				}),
			}),
			CHECKED,
		);
		expect(discovered.fill).toBe("ok");

		const running = fillHealthFrom(
			overlay({
				discover: {
					systemId: "primer",
					jobId: "job-1",
					kind: "seed",
					trigger: "deploy-drift",
					startedAt: CHECKED,
				},
				freshness: liveRows({
					antd: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
				}),
			}),
			CHECKED,
		);
		expect(running.fill).toBe("ok");

		const filling = fillHealthFrom(
			overlay({
				freshness: liveRows({
					antd: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
					primer: { pending: 2, claimed: 1 },
				}),
			}),
			CHECKED,
		);
		expect(filling.fill).toBe("ok");
	});

	it("alarms stuck:<id> when that seed has failed pages and nothing pending or claimed", () => {
		const body = fillHealthFrom(
			overlay({
				freshness: liveRows({
					paste: { failed: 1 },
					uswds: { failed: 3 },
				}),
			}),
			CHECKED,
		);
		expectAlarm(body, ["stuck:paste", "stuck:uswds"]);
	});

	it("does not alarm stuck while that seed is still filling", () => {
		const body = fillHealthFrom(
			overlay({
				state: "running",
				freshness: liveRows({ primer: { pending: 1, failed: 2, claimed: 1 } }),
			}),
			CHECKED,
		);
		expect(body).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });
	});

	it("alarms pending_no_claims:<id> when a Filling seed has no claim or done pages and another seed is claimed", () => {
		const body = fillHealthFrom(
			overlay({
				state: "running",
				freshness: liveRows({
					antd: { pending: 4, claimed: 0, done: 0, lastIndexed: null, lastCrawled: null },
					primer: { pending: 0, claimed: 2, done: 1 },
				}),
			}),
			CHECKED,
		);
		expectAlarm(body, ["pending_no_claims:antd"]);
	});

	it("does not alarm pending_no_claims for mid-fill alone or once a page is done", () => {
		const alone = fillHealthFrom(
			overlay({
				state: "running",
				freshness: liveRows({
					antd: { pending: 4, claimed: 0, done: 0, lastIndexed: null, lastCrawled: null },
				}),
			}),
			CHECKED,
		);
		expect(alone.fill).toBe("ok");

		const progressed = fillHealthFrom(
			overlay({
				state: "running",
				freshness: liveRows({
					antd: { pending: 4, claimed: 0, done: 1, lastIndexed: null, lastCrawled: null },
					primer: { claimed: 1 },
				}),
			}),
			CHECKED,
		);
		expect(progressed.fill).toBe("ok");
	});

	it("alarms hard_fail for global fail, a discover run error, or an idle non-Parked error", () => {
		expectAlarm(fillHealthFrom(overlay({ state: "fail" }), CHECKED), ["hard_fail"]);
		expectAlarm(
			fillHealthFrom(overlay({ state: "ok", runError: "discover failed" }), CHECKED),
			["hard_fail"],
		);
		expectAlarm(
			fillHealthFrom(
				overlay({
					systems: [systemError("primer", "crawl ended failed")],
				}),
				CHECKED,
			),
			["hard_fail"],
		);
	});

	it("does not hard_fail a Parked stub or an error that is still mid-fill", () => {
		const parked = fillHealthFrom(
			overlay({
				parks: { garden: { reason: "stub", usable: 1, at: CHECKED } },
				systems: [systemError("garden", "stub: only 1 usable page(s)", true)],
				freshness: liveRows({
					garden: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
				}),
			}),
			CHECKED,
		);
		expect(parked.fill).toBe("ok");

		const filling = fillHealthFrom(
			overlay({
				state: "running",
				systems: [systemError("primer", "crawl ended failed")],
				freshness: liveRows({ primer: { pending: 2, claimed: 1 } }),
			}),
			CHECKED,
		);
		expect(filling.fill).toBe("ok");
	});

	it("lists every matching alarm and still omits the fill ok substring", () => {
		const body = fillHealthFrom(
			overlay({
				state: "fail",
				runError: "queue stuck",
				freshness: liveRows({
					antd: { lastCrawled: null, lastIndexed: null, lastDiscovered: null, done: 0 },
					uswds: { failed: 2 },
				}),
			}),
			CHECKED,
		);
		expectAlarm(body, ["fleet_freeze", "stuck:uswds", "hard_fail"]);
	});
});

describe("GET /v1/fill-health", () => {
	it("returns 401 for a missing token, a wrong token, and an unset secret", async () => {
		const { env } = envWithIndex(fixtureChunks, true, { STATUS_TOKEN, INDEX: memoryKV() });
		const missing = await worker.fetch(new Request("https://example.test/v1/fill-health"), env);
		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({ error: "unauthorized" });

		const wrong = await worker.fetch(authed("https://example.test/v1/fill-health", "nope"), env);
		expect(wrong.status).toBe(401);

		const { env: open } = envWithIndex(fixtureChunks, true, { INDEX: memoryKV() });
		const unset = await worker.fetch(authed("https://example.test/v1/fill-health"), open);
		expect(unset.status).toBe(401);

		const health = await worker.fetch(new Request("https://example.test/health"), env);
		expect(health.status).toBe(200);
	});

	it("accepts Bearer or ?token= and does not echo the token", async () => {
		const now = new Date().toISOString();
		const { env } = await fleetEnv(now);
		const bearer = await worker.fetch(authed("https://example.test/v1/fill-health"), env);
		const bearerText = await bearer.text();
		expect(bearer.status).toBe(200);
		expect(bearerText).toContain('"fill":"ok"');
		expect(bearerText).not.toContain(STATUS_TOKEN);

		const query = await worker.fetch(
			new Request(`https://example.test/v1/fill-health?token=${STATUS_TOKEN}`),
			env,
		);
		const queryText = await query.text();
		expect(query.status).toBe(200);
		expect(queryText).toContain('"fill":"ok"');
		expect(queryText).not.toContain(STATUS_TOKEN);
	});

	it("reads the index overlay once and matches that document", async () => {
		const now = new Date().toISOString();
		const { env } = await fleetEnv(now);
		const watch = watchReads(env);
		const index = env.INDEX as unknown as { store: Map<string, string> };
		const stored = new Map(index.store);
		const response = await worker.fetch(authed("https://example.test/v1/fill-health"), env);
		const routeReads = watch.counts();
		const text = await response.text();
		const body = JSON.parse(text) as FillHealthBody;
		const mark = watch.counts();
		const overlayDoc = await readStatus(env);
		const second = watch.counts();

		expect(response.status).toBe(200);
		expect(text).toContain('"fill":"ok"');
		expect(body.alarms).toEqual([]);
		expect(body.fill).toBe("ok");
		expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body).toEqual(fillHealthFrom(overlayDoc, body.checkedAt));
		expect(routeReads).toEqual({
			gets: second.gets - mark.gets,
			prepares: second.prepares - mark.prepares,
		});
		expect(routeReads.gets).toBeGreaterThan(0);
		expect(routeReads.prepares).toBeGreaterThan(0);
		expect(index.store).toEqual(stored);
	});

	it("returns 401 without reading the overlay", async () => {
		const now = new Date().toISOString();
		const { env } = await fleetEnv(now);
		const watch = watchReads(env);
		const response = await worker.fetch(new Request("https://example.test/v1/fill-health"), env);
		expect(response.status).toBe(401);
		expect(watch.counts()).toEqual({ gets: 0, prepares: 0 });
	});

	it("alarms each predicate from the live overlay and never returns fill ok", async () => {
		const now = new Date().toISOString();
		const stale = new Date(Date.parse(now) - 31 * 24 * 60 * 60 * 1000).toISOString();

		const frozen = await probe(await fleetEnv(now, ["antd"]));
		expect(frozen.body.alarms).toEqual(["fleet_freeze"]);
		expect(frozen.text).not.toContain('"fill":"ok"');

		const due = await fleetEnv(now);
		await due.db
			.prepare("UPDATE page_work SET last_crawled = ?, last_indexed = ? WHERE system_id = ?")
			.bind(stale, stale, "antd")
			.run();
		await due.db
			.prepare("UPDATE system_mark SET last_discovered = ? WHERE system_id = ?")
			.bind(stale, "antd")
			.run();
		const dueProbe = await probe(due);
		expect(dueProbe.body.alarms).toEqual(["fleet_freeze"]);
		expect(dueProbe.text).not.toContain('"fill":"ok"');

		const stuck = await fleetEnv(now, ["uswds"]);
		await stuck.queue.enqueueUpsert(
			[{ systemId: "uswds", url: "https://example.test/uswds-failed", kind: "reindex" }],
			now,
		);
		await stuck.db
			.prepare("UPDATE page_work SET status = 'failed', last_crawled = ?, last_indexed = ? WHERE system_id = ?")
			.bind(now, now, "uswds")
			.run();
		await stuck.queue.markDiscovered("uswds", now);
		const stuckProbe = await probe(stuck);
		expect(stuckProbe.body.alarms).toEqual(["stuck:uswds"]);
		expect(stuckProbe.text).not.toContain('"fill":"ok"');

		const starved = await fleetEnv(now, ["antd", "paste"]);
		await starved.queue.enqueueUpsert(
			[
				{ systemId: "antd", url: "https://example.test/antd-a", kind: "reindex" },
				{ systemId: "antd", url: "https://example.test/antd-b", kind: "reindex" },
				{ systemId: "paste", url: "https://example.test/paste", kind: "reindex" },
			],
			now,
		);
		await starved.db
			.prepare("UPDATE page_work SET status = 'claimed', claimed_at = ?, last_indexed = ? WHERE system_id = ?")
			.bind(now, now, "paste")
			.run();
		await starved.queue.markDiscovered("paste", now);
		const starvedProbe = await probe(starved);
		expect(starvedProbe.body.alarms).toEqual(["pending_no_claims:antd"]);
		expect(starvedProbe.text).not.toContain('"fill":"ok"');

		const failed = await fleetEnv(now);
		await writeStatus(failed.env, { ...emptyStatus(false), state: "fail", runError: "discover failed" });
		const failedProbe = await probe(failed);
		expect(failedProbe.body.alarms).toEqual(["hard_fail"]);
		expect(failedProbe.text).not.toContain('"fill":"ok"');
		expect(failedProbe.text).not.toContain(STATUS_TOKEN);

		const errored = await fleetEnv(now);
		await writeStatus(errored.env, {
			...emptyStatus(false),
			state: "ok",
			systems: [systemError("primer", "crawl ended failed")],
		});
		const erroredProbe = await probe(errored);
		expect(erroredProbe.body.alarms).toEqual(["hard_fail"]);
		expect(erroredProbe.text).not.toContain('"fill":"ok"');
	});

	it("stays ok for mid-fill, a Parked stub, and Live idle", async () => {
		const now = new Date().toISOString();

		const filling = await fleetEnv(now, ["primer"]);
		await filling.queue.enqueueUpsert(
			[
				{ systemId: "primer", url: "https://example.test/primer-a", kind: "reindex" },
				{ systemId: "primer", url: "https://example.test/primer-b", kind: "reindex" },
			],
			now,
		);
		await filling.db
			.prepare("UPDATE page_work SET status = 'claimed', claimed_at = ? WHERE system_id = ? AND url = ?")
			.bind(now, "primer", "https://example.test/primer-b")
			.run();
		await filling.queue.markDiscovered("primer", now);
		await writeStatus(filling.env, { ...emptyStatus(false), state: "running" });
		const fillingProbe = await probe(filling);
		expect(fillingProbe.body).toMatchObject({ fill: "ok", alarms: [] });
		expect(fillingProbe.text).toContain('"fill":"ok"');

		const parked = await fleetEnv(now, ["garden"]);
		await writePark(parked.env, "garden", 1, now);
		await writeStatus(parked.env, {
			...emptyStatus(false),
			state: "ok",
			systems: [systemError("garden", "stub: only 1 usable page(s)", true)],
		});
		const parkedProbe = await probe(parked);
		expect(parkedProbe.body.fill).toBe("ok");
		expect(parkedProbe.body.alarms).toEqual([]);

		const live = await probe(await fleetEnv(now));
		expect(live.body.fill).toBe("ok");
		expect(live.text).toContain('"fill":"ok"');
	});
});

type Fleet = {
	env: WorkerEnv;
	db: D1Database;
	queue: D1PageQueue;
};

async function fleetEnv(now: string, skip: readonly SystemId[] = []): Promise<Fleet> {
	const kv = memoryKV();
	const db = memoryD1();
	const queue = new D1PageQueue(db);
	await queue.ensure();
	const skipSet = new Set(skip);
	const items = SYSTEM_IDS.filter((systemId) => !skipSet.has(systemId)).map((systemId) => ({
		systemId,
		url: `https://example.test/${systemId}`,
		kind: "reindex" as const,
	}));
	await queue.enqueueUpsert(items, now);
	for (const item of items) {
		await queue.complete(item, { lastCrawled: now, lastIndexed: now }, `${item.systemId}/key`);
		await queue.markDiscovered(item.systemId, now);
	}
	const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, PAGE_QUEUE: db, STATUS_TOKEN });
	await writeStatus(env, { ...emptyStatus(false), state: "ok" });
	return { env, db, queue };
}

async function probe(fleet: Fleet): Promise<{ text: string; body: FillHealthBody }> {
	const response = await worker.fetch(authed("https://example.test/v1/fill-health"), fleet.env);
	expect(response.status).toBe(200);
	const text = await response.text();
	return { text, body: JSON.parse(text) as FillHealthBody };
}

function watchReads(env: WorkerEnv): { counts: () => { gets: number; prepares: number } } {
	let gets = 0;
	let prepares = 0;
	const index = env.INDEX;
	const queue = env.PAGE_QUEUE;
	if (!index || !queue) {
		throw new Error("overlay bindings required");
	}
	const get = index.get.bind(index);
	index.get = (async (key: string) => {
		gets += 1;
		return get(key);
	}) as KVNamespace["get"];
	const prepare = queue.prepare.bind(queue);
	queue.prepare = ((sql: string) => {
		prepares += 1;
		return prepare(sql);
	}) as D1Database["prepare"];
	return {
		counts: () => ({ gets, prepares }),
	};
}
