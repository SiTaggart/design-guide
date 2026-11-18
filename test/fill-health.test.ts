import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS, type SystemId } from "../src/config/types.ts";
import type { WorkerEnv } from "../src/index/ai-search.ts";
import type { SystemFreshness } from "../src/index/page-queue.ts";
import { PARKS_KEY, readParks } from "../src/index/parks.ts";
import { seedHashKey, systemSeedHash } from "../src/index/seed-hash.ts";
import { swapFromOutcome } from "../src/index/reindex.ts";
import { emptyStatus, readStatus, writeStatus, type IndexStatusDocument } from "../src/index/status.ts";
import { fillHealthFrom, type FillHealthBody } from "../src/serve/fill-health.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const STATUS_TOKEN = "test-status-token";
const CHECKED = "2026-10-05T16:00:00.000Z";
const STALE = "2026-08-01T00:00:00.000Z";
const TWENTY_HOURS_BEFORE = new Date(Date.parse(CHECKED) - 20 * 60 * 60 * 1000).toISOString();
const UNDER_THIRTY_MIN = new Date(Date.parse(CHECKED) - 29 * 60 * 1000).toISOString();
const THIRTY_MIN_BEFORE = new Date(Date.parse(CHECKED) - 30 * 60 * 1000).toISOString();

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

function staleRows(overrides: Partial<Record<SystemId, Partial<SystemFreshness>>> = {}): SystemFreshness[] {
	return liveRows(overrides).map((row) => ({
		...row,
		lastCrawled: STALE,
		lastIndexed: STALE,
		lastDiscovered: STALE,
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

function pendingCrawl(lastCrawled: string): IndexStatusDocument {
	const freshness = liveRows({
		patternfly: {
			pending: 2049,
			claimed: 0,
			failed: 0,
			done: 532,
			lastIndexed: CHECKED,
			lastDiscovered: CHECKED,
		},
	}).map((row) => ({ ...row, lastCrawled }));
	return overlay({
		state: "running",
		discover: {
			systemId: "patternfly",
			jobId: "job-patternfly",
			kind: "seed",
			trigger: "deploy-drift",
			startedAt: CHECKED,
		},
		freshness,
	});
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

	it("does not fleet_freeze when every page is done and a Live seed hash has drifted", () => {
		const body = fillHealthFrom(overlay(), CHECKED, { drifted: new Set(["antd"]) });
		expect(body.alarms).not.toContain("fleet_freeze");
		expect(body).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });
	});

	it("alarms fleet_freeze when a seed has no pages and no lastDiscovered", () => {
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

	it("alarms when pending pages have not been crawled for longer than the stall window", () => {
		const lastCrawled = new Date(Date.parse(CHECKED) - 31 * 60 * 1000).toISOString();
		const body = fillHealthFrom(
			overlay({
				freshness: liveRows({
					primer: { pending: 2, done: 577, lastCrawled, lastIndexed: CHECKED, lastDiscovered: CHECKED },
				}).map((row) => ({ ...row, lastCrawled })),
			}),
			CHECKED,
		);
		expect(body.fill).toBe("alarm");
		expect(body.alarms).toContain("crawl_stalled");
		expect(body.alarms).toContain("crawl_stalled:primer");
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

	it("does not fleet_freeze a Live seed for a drifted hash alone", () => {
		const drifted = fillHealthFrom(overlay(), CHECKED, { drifted: new Set(["antd"]) });
		expect(drifted).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });

		const live = fillHealthFrom(
			overlay({
				freshness: liveRows({
					antd: { lastCrawled: STALE, lastIndexed: STALE, lastDiscovered: STALE },
				}),
			}),
			CHECKED,
		);
		expect(live).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });
	});

	it("fleet_freezes a drifted non-live seed without a cap-defer table", () => {
		const drained = overlay({
			systems: [{ ...systemError("paste", "crawl hit the 500 page limit"), hitLimit: true }],
		});
		const drifted = new Set<SystemId>(["paste"]);
		expectAlarm(fillHealthFrom(drained, CHECKED, { drifted }), ["fleet_freeze"]);
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

	it("does not hard_fail a drained seed that hit the crawl page cap", () => {
		const freshness = liveRows({ paste: { pending: 0, claimed: 0, failed: 0, done: 513 } });
		const capped = {
			system: "paste" as const,
			startUrl: "https://paste-dsys.com/",
			crawl: { total: 533, finished: 533, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 0,
			hitLimit: true,
			keptPrevious: true,
			usable: 513,
			error: "crawl hit the 500 page limit",
		};
		expect(fillHealthFrom(overlay({ state: "running", systems: [capped], freshness }), CHECKED)).toEqual({
			fill: "ok",
			alarms: [],
			checkedAt: CHECKED,
		});
		const { error: _capNote, ...cleared } = capped;
		expect(fillHealthFrom(overlay({ state: "running", systems: [cleared], freshness }), CHECKED)).toEqual({
			fill: "ok",
			alarms: [],
			checkedAt: CHECKED,
		});
	});

	it("failed at cap keeps error + hard_fail", async () => {
		const seed = seedById("paste");
		const counts = { total: 533, finished: 533, skipped: 0, disallowed: 0, errored: 1 };
		const auth = { accountId: "acct", apiToken: "token" };
		const outcome = {
			startUrl: seed.startUrl,
			status: "failed",
			counts,
			records: [],
		};
		const fromSwap = await swapFromOutcome(auth, seed, outcome);
		expect(fromSwap).toMatchObject({
			indexed: 0,
			keptPrevious: true,
			hitLimit: false,
			error: "crawl ended failed",
		});
		expectAlarm(
			fillHealthFrom(
				overlay({
					state: "running",
					systems: [fromSwap],
					freshness: liveRows({ paste: { pending: 0, claimed: 0, failed: 0, done: 513 } }),
				}),
				CHECKED,
			),
			["hard_fail"],
		);
		expectAlarm(
			fillHealthFrom(
				overlay({
					state: "running",
					systems: [{ ...fromSwap, hitLimit: true }],
					freshness: liveRows({ paste: { pending: 0, claimed: 0, failed: 0, done: 513 } }),
				}),
				CHECKED,
			),
			["hard_fail"],
		);
	});

	it("still hard_fails a drained seed with a real crawl error", () => {
		expectAlarm(
			fillHealthFrom(
				overlay({
					state: "running",
					systems: [systemError("paste", "crawl ended failed")],
					freshness: liveRows({ paste: { pending: 0, claimed: 0, failed: 0, done: 513 } }),
				}),
				CHECKED,
			),
			["hard_fail"],
		);
	});

	it("does not hard_fail a sticky fail or runError while discover or the queue is still filling", () => {
		const sticky = {
			state: "fail" as const,
			runError: "D1_ERROR: Network connection lost.",
			finishedAt: STALE,
			systems: [systemError("paste", "crawl hit the 500 page limit")],
		};
		const discovering = fillHealthFrom(
			overlay({
				...sticky,
				systems: [],
				freshness: staleRows(),
				discover: {
					systemId: "nhs",
					jobId: "job-nhs",
					kind: "seed",
					trigger: "deploy-drift",
					startedAt: CHECKED,
				},
			}),
			CHECKED,
		);
		expect(discovering).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });

		const draining = fillHealthFrom(
			overlay({
				...sticky,
				freshness: liveRows({ paste: { pending: 72, claimed: 60 } }),
			}),
			CHECKED,
		);
		expect(draining).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });

		const runErrorOnly = fillHealthFrom(
			overlay({
				state: "ok",
				runError: "D1_ERROR: Network connection lost.",
				finishedAt: STALE,
				freshness: liveRows({ cloudscape: { pending: 1, claimed: 1 } }),
			}),
			CHECKED,
		);
		expect(runErrorOnly).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });

		const idleSeed = fillHealthFrom(
			overlay({
				...sticky,
				systems: [
					systemError("paste", "crawl hit the 500 page limit"),
					systemError("primer", "crawl ended failed"),
				],
				freshness: liveRows({ paste: { pending: 72, claimed: 60 } }),
			}),
			CHECKED,
		);
		expectAlarm(idleSeed, ["hard_fail"]);
	});

	it("alarms hard_fail when claimed work has not moved since the run error", () => {
		const stalled = staleRows({ paste: { pending: 72, claimed: 60 } });
		const claimed = fillHealthFrom(
			overlay({
				state: "fail",
				runError: "D1_ERROR: Network connection lost.",
				finishedAt: CHECKED,
				freshness: stalled,
			}),
			CHECKED,
		);
		expectAlarm(claimed, ["hard_fail", "crawl_stalled", "crawl_stalled:paste"]);

		const discovering = fillHealthFrom(
			overlay({
				state: "fail",
				runError: "ensureInstance failed",
				finishedAt: CHECKED,
				freshness: stalled,
				discover: {
					systemId: "nhs",
					jobId: "job-nhs",
					kind: "seed",
					trigger: "deploy-drift",
					startedAt: STALE,
				},
			}),
			CHECKED,
		);
		expectAlarm(discovering, ["hard_fail", "crawl_stalled", "crawl_stalled:paste"]);
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

	it("alarms crawl_stalled when pending pages have not been crawled for 20 hours", () => {
		const body = fillHealthFrom(pendingCrawl(TWENTY_HOURS_BEFORE), CHECKED);
		expectAlarm(body, ["crawl_stalled", "crawl_stalled:patternfly"]);
	});

	it("stays ok when pending pages were crawled within 30 minutes", () => {
		for (const lastCrawled of [UNDER_THIRTY_MIN, THIRTY_MIN_BEFORE]) {
			const body = fillHealthFrom(pendingCrawl(lastCrawled), CHECKED);
			expect(body).toEqual({ fill: "ok", alarms: [], checkedAt: CHECKED });
		}
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

	it("stays JSON 200 when one seed hash read fails", async () => {
		const now = new Date().toISOString();
		const { env } = await fleetEnv(now);
		const index = env.INDEX;
		if (!index) {
			throw new Error("INDEX required");
		}
		const get = index.get.bind(index);
		const failing = seedHashKey("antd");
		index.get = (async (key: string) => {
			if (key === failing) {
				throw new Error("kv hash timeout");
			}
			return get(key);
		}) as KVNamespace["get"];

		const response = await worker.fetch(authed("https://example.test/v1/fill-health"), env);
		expect(response.status).toBe(200);
		const text = await response.text();
		const body = JSON.parse(text) as FillHealthBody;
		expect(text).toContain('"fill":"ok"');
		expect(body).toMatchObject({ fill: "ok", alarms: [] });
		expect(body.alarms).not.toContain("fleet_freeze");
		expect(text).not.toContain("kv hash timeout");
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
		const afterOverlay = watch.counts();
		const drifted = new Set<SystemId>();
		for (const id of SYSTEM_IDS) {
			const hash = await env.INDEX?.get(seedHashKey(id));
			if (hash !== systemSeedHash(seedById(id))) {
				drifted.add(id);
			}
		}
		const afterHashes = watch.counts();

		expect(response.status).toBe(200);
		expect(text).toContain('"fill":"ok"');
		expect(body.alarms).toEqual([]);
		expect(body.fill).toBe("ok");
		expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body).toEqual(
			fillHealthFrom(overlayDoc, body.checkedAt, { drifted }),
		);
		expect(routeReads).toEqual({
			gets: afterOverlay.gets - mark.gets + (afterHashes.gets - afterOverlay.gets),
			prepares: afterOverlay.prepares - mark.prepares,
		});
		expect(afterHashes.gets - afterOverlay.gets).toBe(SYSTEM_IDS.length);
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

		const frozen = await probe(await fleetEnv(now, ["antd"]));
		expect(frozen.body.alarms).toEqual(["fleet_freeze"]);
		expect(frozen.text).not.toContain('"fill":"ok"');

		const drifted = await fleetEnv(now);
		await drifted.env.INDEX?.delete(seedHashKey("antd"));
		const driftedProbe = await probe(drifted);
		expect(driftedProbe.body.alarms).toEqual([]);
		expect(driftedProbe.body.fill).toBe("ok");
		expect(driftedProbe.text).toContain('"fill":"ok"');

		const stuck = await fleetEnv(now, ["uswds"]);
		await insertWork(stuck.db, "uswds", "https://example.test/uswds-failed", "failed", now, now, now);
		await markDiscovered(stuck.db, "uswds", now);
		const stuckProbe = await probe(stuck);
		expect(stuckProbe.body.alarms).toEqual(["stuck:uswds"]);
		expect(stuckProbe.text).not.toContain('"fill":"ok"');

		const starved = await fleetEnv(now, ["antd", "paste"]);
		await insertWork(starved.db, "antd", "https://example.test/antd-a", "pending", now);
		await insertWork(starved.db, "antd", "https://example.test/antd-b", "pending", now);
		await insertWork(starved.db, "paste", "https://example.test/paste", "claimed", now, null, now, now);
		await markDiscovered(starved.db, "paste", now);
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

	it("fleet_freezes a drifted non-live seed when cap_defer is gone", async () => {
		const now = new Date().toISOString();
		const fleet = await fleetEnv(now);
		await writeStatus(fleet.env, {
			...emptyStatus(false),
			state: "ok",
			systems: [{ ...systemError("paste", "crawl hit the 500 page limit"), hitLimit: true }],
		});
		await fleet.env.INDEX?.delete(seedHashKey("paste"));
		const frozen = await probe(fleet);
		expect(frozen.body.alarms).toEqual(["fleet_freeze"]);
		expect(frozen.text).not.toContain('"fill":"ok"');
	});

	it("does not hard_fail a sticky run error while discover or the queue is still filling", async () => {
		const now = new Date().toISOString();
		const draining = await fleetEnv(now);
		await insertWork(draining.db, "paste", "https://example.test/paste-pending", "pending", now);
		await writeStatus(draining.env, {
			...emptyStatus(false),
			state: "fail",
			runError: "D1_ERROR: Network connection lost.",
			finishedAt: new Date(Date.parse(now) - 60_000).toISOString(),
			systems: [systemError("paste", "crawl hit the 500 page limit")],
		});
		const drainingProbe = await probe(draining);
		expect(drainingProbe.body).toMatchObject({ fill: "ok", alarms: [] });
		expect(drainingProbe.text).toContain('"fill":"ok"');
		expect(drainingProbe.text).not.toContain("hard_fail");

		const stalled = await fleetEnv(now);
		await insertWork(stalled.db, "paste", "https://example.test/paste-stuck", "claimed", now, null, null, now);
		await writeStatus(stalled.env, {
			...emptyStatus(false),
			state: "fail",
			runError: "ensureInstance failed",
			finishedAt: new Date(Date.parse(now) + 60_000).toISOString(),
		});
		const stalledProbe = await probe(stalled);
		expect(stalledProbe.body.alarms).toEqual(["hard_fail"]);
		expect(stalledProbe.text).not.toContain('"fill":"ok"');
	});

	it("stays ok for mid-fill, a Parked stub, and Live idle", async () => {
		const now = new Date().toISOString();

		const filling = await fleetEnv(now, ["primer"]);
		await insertWork(filling.db, "primer", "https://example.test/primer-a", "pending", now);
		await insertWork(filling.db, "primer", "https://example.test/primer-b", "claimed", now, null, null, now);
		await markDiscovered(filling.db, "primer", now);
		await writeStatus(filling.env, { ...emptyStatus(false), state: "running" });
		const fillingProbe = await probe(filling);
		expect(fillingProbe.body).toMatchObject({ fill: "ok", alarms: [] });
		expect(fillingProbe.text).toContain('"fill":"ok"');

		const parked = await fleetEnv(now, ["garden"]);
		await putPark(parked.env, "garden", 1, now);
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
};

async function insertWork(
	db: D1Database,
	systemId: SystemId,
	url: string,
	status: string,
	now: string,
	crawled: string | null = null,
	indexed: string | null = null,
	claimedAt: string | null = null,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts, claimed_at, last_crawled, last_indexed)
			 VALUES (?, ?, 'reindex', ?, ?, 0, ?, ?, ?)`,
		)
		.bind(systemId, url, status, now, claimedAt, crawled, indexed)
		.run();
}

async function markDiscovered(db: D1Database, systemId: SystemId, now: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET last_discovered = excluded.last_discovered`,
		)
		.bind(systemId, now)
		.run();
}

async function fleetEnv(now: string, skip: readonly SystemId[] = []): Promise<Fleet> {
	const kv = memoryKV();
	const db = memoryD1();
	const skipSet = new Set(skip);
	for (const systemId of SYSTEM_IDS) {
		if (skipSet.has(systemId)) {
			continue;
		}
		await insertWork(db, systemId, `https://example.test/${systemId}`, "done", now, now, now);
		await markDiscovered(db, systemId, now);
	}
	const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, PAGE_QUEUE: db, STATUS_TOKEN });
	await writeStatus(env, { ...emptyStatus(false), state: "ok" });
	for (const systemId of SYSTEM_IDS) {
		await env.INDEX?.put(seedHashKey(systemId), systemSeedHash(seedById(systemId)));
	}
	return { env, db };
}

async function putPark(env: WorkerEnv, system: SystemId, usable: number, at: string): Promise<void> {
	const read = await readParks(env);
	const parks = read.kind === "ok" ? { ...read.parks } : {};
	parks[system] = { reason: "stub", usable, at };
	await env.INDEX?.put(PARKS_KEY, JSON.stringify(parks));
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
