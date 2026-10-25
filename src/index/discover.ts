import { INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { SystemId } from "../config/types.ts";
import {
	CRAWL_POLL_DEADLINE_MS,
	cancelCrawl,
	crawlStoppedEarly,
	fetchCrawlPage,
	pollJob,
	reachedRunawayCeiling,
	startSeedCrawl,
	type CrawlAuth,
} from "../crawl/browser-run.ts";
import { admittedUrl, frontierLinks, linkBase } from "../crawl/links.ts";
import type { WorkerEnv } from "./ai-search.ts";
import { readIndexedHashes, writeIndexedHash, writeLastIndexedHashIfComplete } from "./indexed-hashes.ts";
import { deleteItem, deleteItemByKey, listItems, type ItemsAuth } from "./items-rest.ts";
import { parkedSystemIds, readParks, writePark, type Parks } from "./parks.ts";
import { isStubGeneration, fitsItem } from "./reindex.ts";
import { driftedSystems, systemSeedHash } from "./seed-hash.ts";
import { isRecoveryCron } from "./trigger.ts";
import { isTickDeadlineStop, type D1QueueOptions } from "./d1-step.ts";
import {
	D1PageQueue,
	FRESHNESS_MS,
	isDue,
	type DiscoverRun,
	type PageKind,
	type PageQueue,
} from "./page-queue.ts";

export const DISCOVER_URLS_PER_TICK = 25;
export const CAP_RETRY_MS = 60 * 60 * 1000;
export const DISCOVER_SLOT_BUDGET_MS = 24 * 60 * 60 * 1000;
/** Resume has no crawl job yet. Poll would have nothing to read, so the frontier loop runs instead. */
const AWAITING_FRONTIER_JOB = "";

export type CapDeferMark = string | { at: string; streak: number };

export function capRetryDelayMs(streak: number): number {
	if (streak <= 1) {
		return CAP_RETRY_MS;
	}
	if (streak === 2) {
		return 6 * CAP_RETRY_MS;
	}
	if (streak === 3) {
		return 24 * CAP_RETRY_MS;
	}
	return 7 * 24 * CAP_RETRY_MS;
}
/** One record per results request. Markdown stays on the response, then is discarded. */
export const DISCOVER_RECORD_LIMIT = 1;
const MAX_POLL_FAILURES = 5;
const MAX_SKIPPED_STARTS = 3;

export type DiscoverPick = {
	systemId: SystemId;
	kind: PageKind;
	trigger: "deploy-drift" | "recrawl" | "recovery";
};

export type DiscoverTickResult =
	| { action: "skip"; reason: string }
	| { action: "started"; systemId: SystemId; kind: PageKind; trigger: DiscoverPick["trigger"] }
	| { action: "continued"; systemId: SystemId; accepted: number }
	| {
			action: "enqueued";
			systemId: SystemId;
			kind: PageKind;
			trigger: DiscoverPick["trigger"];
			urls: number;
			pruned: string[];
			hitLimit: boolean;
			incomplete: boolean;
	  }
	| { action: "parked"; systemId: SystemId; trigger: DiscoverPick["trigger"]; usable: number }
	| { action: "failed"; systemId?: SystemId; trigger?: DiscoverPick["trigger"]; error: string };

type DroppedPage = { url: string; itemKey: string | null };

export function pickDiscoverSystem(input: {
	cron: string;
	drifted: readonly SystemId[];
	due: readonly SystemId[];
	parked: readonly SystemId[];
	parks: Parks;
	busy?: ReadonlySet<SystemId>;
	recoveryAttempts?: Readonly<Record<string, string>>;
	deferred?: Readonly<Record<string, CapDeferMark>>;
	now?: number;
}): DiscoverPick | null {
	const busy = input.busy ?? new Set<SystemId>();
	const deferred = input.deferred ?? {};
	const cooling = (id: SystemId) => capCooling(id, deferred, input.now);
	if (isRecoveryCron(input.cron)) {
		const systemId = nextParkedSystem(input.parked, input.recoveryAttempts ?? {});
		if (!systemId) {
			return null;
		}
		return {
			systemId,
			kind: input.drifted.includes(systemId) ? "seed" : "reindex",
			trigger: "recovery",
		};
	}
	const drifted = input.drifted.find((id) => input.parks[id] === undefined && !busy.has(id) && !cooling(id));
	if (drifted) {
		return { systemId: drifted, kind: "seed", trigger: "deploy-drift" };
	}
	const due = input.due.find((id) => input.parks[id] === undefined && !cooling(id));
	if (due) {
		return { systemId: due, kind: "reindex", trigger: "recrawl" };
	}
	return null;
}

export function capCooling(
	id: SystemId,
	deferred: Readonly<Record<string, CapDeferMark>>,
	now: number | undefined,
): boolean {
	const mark = deferred[id];
	if (!mark) {
		return false;
	}
	const at = typeof mark === "string" ? mark : mark.at;
	const streak = typeof mark === "string" ? 1 : mark.streak;
	if (now === undefined) {
		return true;
	}
	return now - Date.parse(at) < capRetryDelayMs(streak);
}

export function nextParkedSystem(
	parked: readonly SystemId[],
	attempts: Readonly<Record<string, string>>,
): SystemId | undefined {
	return [...parked].sort((left, right) => {
		const leftAttempt = attempts[left];
		const rightAttempt = attempts[right];
		if (leftAttempt === rightAttempt) {
			return 0;
		}
		if (leftAttempt === undefined) {
			return -1;
		}
		if (rightAttempt === undefined) {
			return 1;
		}
		return leftAttempt < rightAttempt ? -1 : 1;
	})[0];
}

export function dueSystemIds(
	rows: ReadonlyArray<{
		system: SystemId;
		lastIndexed: string | null;
		lastDiscovered: string | null;
		pending: number;
		claimed: number;
	}>,
	now: number,
	resumed: readonly SystemId[] = [],
): SystemId[] {
	const waiting = new Set(resumed);
	return rows
		.filter((row) =>
			isDue({
				lastIndexed: row.lastIndexed,
				lastDiscovered: row.lastDiscovered,
				pending: row.pending + row.claimed,
				now,
				hasResume: waiting.has(row.system),
			}),
		)
		.sort((left, right) => {
			if (left.lastIndexed === right.lastIndexed) {
				return left.system < right.system ? -1 : 1;
			}
			if (left.lastIndexed === null) {
				return -1;
			}
			if (right.lastIndexed === null) {
				return 1;
			}
			return left.lastIndexed < right.lastIndexed ? -1 : 1;
		})
		.map((row) => row.system);
}

export async function commitDiscoveredUrls(input: {
	queue: PageQueue;
	systemId: SystemId;
	kind: PageKind;
	urls: readonly string[];
	liveUrls?: readonly string[];
	ok: boolean;
	prune?: boolean;
	keepDone?: boolean;
	now: string;
	deleteDocs: (dropped: readonly DroppedPage[]) => Promise<void>;
}): Promise<{ pruned: DroppedPage[] }> {
	if (!input.ok) {
		return { pruned: [] };
	}
	const enqueue = [...new Set(input.urls)];
	const live = new Set(input.liveUrls ?? enqueue);
	if (enqueue.length > 0) {
		await input.queue.enqueueUpsert(
			enqueue.map((url) => ({ systemId: input.systemId, url, kind: input.kind })),
			input.now,
			input.keepDone ? { keepDone: true } : undefined,
		);
	}
	if (input.prune === false) {
		return { pruned: [] };
	}
	const dropped = await input.queue.listAbsent(input.systemId, live);
	if (dropped.length > 0) {
		await input.deleteDocs(dropped);
		await input.queue.removeUrls(
			input.systemId,
			dropped.map((row) => row.url),
		);
	}
	return { pruned: dropped };
}

export async function deleteOrphanDocs(
	auth: ItemsAuth,
	systemId: SystemId,
	dropped: readonly DroppedPage[],
	liveUrls: ReadonlySet<string> = new Set(),
): Promise<void> {
	const urls = new Set(dropped.map((row) => row.url));
	const keys = new Set(dropped.map((row) => row.itemKey).filter((key): key is string => Boolean(key)));
	const items = await listItems(auth);
	for (const item of items) {
		if (!item.key.startsWith(`${systemId}/`)) {
			continue;
		}
		const sourceUrl = item.metadata?.source_url;
		const metaSystem = item.metadata?.system;
		const systemMatch = metaSystem === undefined || metaSystem === systemId;
		const queuedOrphan = typeof sourceUrl === "string" && urls.has(sourceUrl) && systemMatch;
		const outsideLive =
			liveUrls.size > 0 && typeof sourceUrl === "string" && !liveUrls.has(sourceUrl) && systemMatch;
		const liveSource = typeof sourceUrl === "string" && liveUrls.has(sourceUrl) && systemMatch;
		if (liveSource) {
			keys.delete(item.key);
			continue;
		}
		if (!queuedOrphan && !outsideLive && !keys.has(item.key)) {
			continue;
		}
		await deleteItem(auth, item.id);
		keys.delete(item.key);
	}
	for (const key of keys) {
		await deleteItemByKey(auth, key);
	}
}

const defaultDeps: DiscoverDeps = {
	start: startSeedCrawl,
	poll: pollJob,
	page: fetchCrawlPage,
	cancel: cancelCrawl,
	deleteDocs: deleteOrphanDocs,
};

export type DiscoverDeps = {
	start: typeof startSeedCrawl;
	poll: typeof pollJob;
	page: typeof fetchCrawlPage;
	cancel: typeof cancelCrawl;
	deleteDocs: typeof deleteOrphanDocs;
};

function cappedCrawl(status: string, finished: number): boolean {
	return crawlStoppedEarly(status, finished);
}

export async function discoverTick(
	env: WorkerEnv,
	cron: string,
	now = new Date(),
	deps: Partial<DiscoverDeps> = {},
	queueOptions?: D1QueueOptions,
): Promise<DiscoverTickResult> {
	try {
		return await runDiscover(env, cron, now, { ...defaultDeps, ...deps }, queueOptions);
	} catch (error) {
		if (isTickDeadlineStop(error)) {
			return { action: "skip", reason: "deadline" };
		}
		return { action: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

async function runDiscover(
	env: WorkerEnv,
	cron: string,
	now: Date,
	deps: DiscoverDeps,
	queueOptions?: D1QueueOptions,
): Promise<DiscoverTickResult> {
	if (!env.PAGE_QUEUE) {
		return { action: "skip", reason: "unbound" };
	}
	const auth = crawlAuth(env);
	if (!auth) {
		return { action: "skip", reason: "no-auth" };
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		return { action: "skip", reason: "unread-parks" };
	}
	const queue = new D1PageQueue(env.PAGE_QUEUE, queueOptions);
	const running = await queue.running();
	if (running) {
		return continueDiscover(env, queue, auth, running, now, deps);
	}
	const freshness = await queue.freshness();
	const pick = pickDiscoverSystem({
		cron,
		drifted: driftedSystems(await readIndexedHashes(env)),
		due: dueSystemIds(freshness, now.getTime(), await queue.resumedSystems()),
		parked: parkedSystemIds(parksRead.parks),
		parks: parksRead.parks,
		busy: new Set(freshness.filter((row) => row.pending + row.claimed > 0).map((row) => row.system)),
		recoveryAttempts: await queue.recoveryAttempts(),
		deferred: await queue.capDeferMarks(),
		now: now.getTime(),
	});
	if (!pick) {
		return { action: "skip", reason: "idle" };
	}
	const seed = seedById(pick.systemId);
	const iso = now.toISOString();
	if (pick.trigger === "recovery") {
		await queue.noteRecoveryAttempt(pick.systemId, iso);
	}
	// discover_resume is the parked slice. A different seed hash, or a yield older than the recrawl window, drops that map and starts over.
	const parked = await queue.discoverResume(pick.systemId);
	if (parked) {
		const resumeStale = now.getTime() - Date.parse(parked.yieldedAt) > FRESHNESS_MS;
		if (parked.seedHash !== systemSeedHash(seed) || resumeStale) {
			await queue.clearRun(pick.systemId);
		} else {
			return resumeDiscover(env, queue, auth, pick, deps, iso);
		}
	}
	let started: { startUrl: string; jobId: string };
	try {
		started = await deps.start(auth, seed);
	} catch (error) {
		return {
			action: "failed",
			systemId: pick.systemId,
			trigger: pick.trigger,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	await queue.insertRun({
		systemId: pick.systemId,
		kind: pick.kind,
		trigger: pick.trigger,
		jobId: started.jobId,
		startUrl: started.startUrl,
		cursor: null,
		pollFailures: 0,
		startedAt: iso,
		now: iso,
	});
	return { action: "started", systemId: pick.systemId, kind: pick.kind, trigger: pick.trigger };
}

async function continueDiscover(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	now: Date,
	deps: DiscoverDeps,
): Promise<DiscoverTickResult> {
	const iso = now.toISOString();
	if (Date.parse(run.startedAt) + CRAWL_POLL_DEADLINE_MS < now.getTime()) {
		await queue.noteAttempt(run.systemId, run.startUrl);
		await cancelJob(auth, run, deps);
		return yieldDiscoverSlot(env, queue, auth, run, deps, iso, true);
	}
	if (run.jobId === AWAITING_FRONTIER_JOB) {
		return followFrontier(env, queue, auth, run, deps, iso, 0);
	}
	let snapshot: { status: string; finished: number };
	try {
		const job = await deps.poll(auth, run.jobId);
		snapshot = {
			status: job.status ?? "unknown",
			finished: typeof job.finished === "number" ? job.finished : 0,
		};
	} catch (error) {
		const failures = await queue.notePollFailure(run.systemId, iso);
		if (failures >= MAX_POLL_FAILURES) {
			return failOrFinish(env, queue, auth, run, deps, iso, startFailureMessage(error));
		}
		return { action: "continued", systemId: run.systemId, accepted: 0 };
	}
	if (snapshot.status === "running" || snapshot.status === "") {
		return { action: "continued", systemId: run.systemId, accepted: 0 };
	}
	const capped = cappedCrawl(snapshot.status, snapshot.finished);
	if (capped) {
		await queue.noteCapped(run.systemId, iso);
	}
	if (!capped && snapshot.status !== "completed") {
		return failOrFinish(env, queue, auth, run, deps, iso, `crawl ended ${snapshot.status}`);
	}
	const seed = seedById(run.systemId);
	let cursor = run.cursor;
	let accepted = 0;
	let runaway = reachedRunawayCeiling(await queue.indexableCount(run.systemId));
	if (cursor !== "done" && !runaway) {
		try {
			for (let i = 0; i < DISCOVER_URLS_PER_TICK && cursor !== "done"; i += 1) {
				if (reachedRunawayCeiling(await queue.indexableCount(run.systemId))) {
					runaway = true;
					cursor = "done";
					await queue.saveCursor(run.systemId, cursor, iso);
					break;
				}
				const page = await deps.page(auth, run.jobId, "completed", cursor ?? undefined, DISCOVER_RECORD_LIMIT);
				for (const record of page.records) {
					const canonical = admittedUrl(record.url, seed);
					if (!canonical) {
						continue;
					}
					await queue.stageUrl(run.systemId, canonical);
					if (record.markdown) {
						await queue.addFrontier(
							run.systemId,
							frontierLinks(record.markdown, linkBase(record.url, record.markdown, seed), seed),
						);
					}
					if (record.status === "completed" && fitsItem({ ...record, url: canonical }, seed)) {
						if (reachedRunawayCeiling(await queue.indexableCount(run.systemId))) {
							runaway = true;
							break;
						}
						await queue.stageIndexable(run.systemId, canonical);
						accepted += 1;
						if (reachedRunawayCeiling(await queue.indexableCount(run.systemId))) {
							runaway = true;
						}
					}
				}
				if (runaway) {
					cursor = "done";
					await queue.saveCursor(run.systemId, cursor, iso);
					break;
				}
				cursor = page.cursor === null ? "done" : String(page.cursor);
				await queue.saveCursor(run.systemId, cursor, iso);
			}
		} catch (error) {
			if (accepted > 0) {
				await queue.noteSliceAccepted(run.systemId);
			}
			if (isTickDeadlineStop(error)) {
				throw error;
			}
			const failures = await queue.notePollFailure(run.systemId, iso);
			if (failures >= MAX_POLL_FAILURES) {
				return failOrFinish(env, queue, auth, run, deps, iso, startFailureMessage(error));
			}
			return { action: "continued", systemId: run.systemId, accepted };
		}
	}
	if (accepted > 0) {
		await queue.noteSliceAccepted(run.systemId);
	}
	if (cursor !== "done") {
		return { action: "continued", systemId: run.systemId, accepted };
	}
	if (!runaway && slotBudgetSpent(run.startedAt, now.getTime())) {
		const seen = new Set(await queue.stagedUrls(run.systemId));
		const next = await queue.nextFrontier(run.systemId, seen);
		if (next) {
			return yieldDiscoverSlot(env, queue, auth, run, deps, iso);
		}
	}
	if (!runaway) {
		return followFrontier(env, queue, auth, run, deps, iso, accepted);
	}
	const incomplete = runaway || (await queue.cappedAny(run.systemId)) || (await queue.skippedAny(run.systemId));
	return finishDiscover(env, queue, auth, run, deps, iso, incomplete);
}

async function followFrontier(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	iso: string,
	accepted: number,
): Promise<DiscoverTickResult> {
	const seed = seedById(run.systemId);
	const seen = new Set(await queue.stagedUrls(run.systemId));
	let next = await queue.nextFrontier(run.systemId, seen);
	while (next) {
		const frontierUrl = next;
		try {
			const started = await deps.start(auth, seed, frontierUrl);
			await queue.replaceJob(run.systemId, started.jobId, started.startUrl, iso);
			return { action: "continued", systemId: run.systemId, accepted };
		} catch (error) {
			if (isTickDeadlineStop(error)) {
				throw error;
			}
			const message = startFailureMessage(error);
			console.log(
				JSON.stringify({
					event: "crawl_start_failed",
					system: run.systemId,
					url: frontierUrl,
					error: message,
				}),
			);
			if (accountAuthFailure(error)) {
				await queue.noteSkipped(run.systemId, iso);
				await queue.noteAttempt(run.systemId, frontierUrl);
				break;
			}
			const failures = await queue.noteStartFailure(run.systemId, iso);
			if (failures < MAX_POLL_FAILURES) {
				return { action: "continued", systemId: run.systemId, accepted };
			}
			const skipped = await queue.noteSkipped(run.systemId, iso);
			await queue.noteAttempt(run.systemId, frontierUrl);
			await queue.clearStartFailures(run.systemId, iso);
			await queue.clearPollFailures(run.systemId, iso);
			if (skipped >= MAX_SKIPPED_STARTS) {
				break;
			}
			next = await queue.nextFrontier(run.systemId, seen);
		}
	}
	if (await queue.skippedAny(run.systemId)) {
		return yieldDiscoverSlot(env, queue, auth, run, deps, iso);
	}
	const incomplete = (await queue.cappedAny(run.systemId)) || (await queue.skippedAny(run.systemId));
	return finishDiscover(env, queue, auth, run, deps, iso, incomplete);
}

function slotBudgetSpent(startedAt: string, nowMs: number): boolean {
	return Date.parse(startedAt) + DISCOVER_SLOT_BUDGET_MS < nowMs;
}

function discoveredLive(staged: readonly string[], indexable: readonly string[]): string[] {
	return [...new Set([...staged, ...indexable])];
}

async function resumeDiscover(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	pick: DiscoverPick,
	deps: DiscoverDeps,
	iso: string,
): Promise<DiscoverTickResult> {
	const seed = seedById(pick.systemId);
	const frontierAtStart = await queue.frontierCount(pick.systemId);
	const seen = new Set(await queue.stagedUrls(pick.systemId));
	const next = await queue.nextFrontier(pick.systemId, seen);
	if (!next) {
		const incomplete = await queue.takeSliceIncomplete(pick.systemId);
		return finishDiscover(
			env,
			queue,
			auth,
			{
				systemId: pick.systemId,
				kind: pick.kind,
				trigger: pick.trigger,
				jobId: "",
				startUrl: seed.startUrl,
				cursor: "done",
				pollFailures: 0,
				startedAt: iso,
			},
			deps,
			iso,
			incomplete,
		);
	}
	await queue.insertRun({
		systemId: pick.systemId,
		kind: pick.kind,
		trigger: pick.trigger,
		jobId: AWAITING_FRONTIER_JOB,
		startUrl: seed.startUrl,
		cursor: null,
		pollFailures: 0,
		startedAt: iso,
		now: iso,
	});
	await queue.saveCursor(pick.systemId, "done", iso);
	await queue.noteSliceBaseline(pick.systemId, frontierAtStart);
	if (await queue.takeSliceIncomplete(pick.systemId)) {
		await queue.noteCapped(pick.systemId, iso);
	}
	const run = await queue.running();
	if (!run) {
		return { action: "failed", systemId: pick.systemId, trigger: pick.trigger, error: "resume run missing" };
	}
	const followed = await followFrontier(env, queue, auth, run, deps, iso, 0);
	if (followed.action === "continued" && (await queue.running())?.jobId) {
		return { action: "started", systemId: pick.systemId, kind: pick.kind, trigger: pick.trigger };
	}
	return followed;
}

async function yieldDiscoverSlot(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	iso: string,
	markIncomplete = false,
): Promise<DiscoverTickResult> {
	const staged = await queue.stagedUrls(run.systemId);
	const indexable = await queue.indexableUrls(run.systemId);
	const live = discoveredLive(staged, indexable);
	const itemsAuth = itemsAuthFrom(env, auth);
	const committed =
		indexable.length === 0
			? { pruned: [] as DroppedPage[] }
			: await commitDiscoveredUrls({
					queue,
					systemId: run.systemId,
					kind: run.kind,
					urls: indexable,
					liveUrls: live,
					ok: true,
					prune: false,
					keepDone: true,
					now: iso,
					deleteDocs: (dropped) => deps.deleteDocs(itemsAuth, run.systemId, dropped, new Set(live)),
				});
	await queue.rememberSliceIncomplete(run.systemId, markIncomplete);
	const defer = (await queue.capDeferMarks())[run.systemId];
	const notedThisSlice = defer !== undefined && Date.parse(defer.at) >= Date.parse(run.startedAt);
	if (!notedThisSlice) {
		if (await queue.sliceMadeProgress(run.systemId)) {
			await queue.noteCapDeferBase(run.systemId, iso);
		} else {
			await queue.noteCapDefer(run.systemId, iso);
		}
	}
	await queue.recordDiscoverResume(run.systemId, systemSeedHash(seedById(run.systemId)), iso);
	await queue.releaseSlot(run.systemId);
	return {
		action: "enqueued",
		systemId: run.systemId,
		kind: run.kind,
		trigger: run.trigger,
		urls: indexable.length,
		pruned: committed.pruned.map((row) => row.url),
		hitLimit: false,
		incomplete: true,
	};
}

async function finishDiscover(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	iso: string,
	incomplete: boolean,
): Promise<DiscoverTickResult> {
	const seed = seedById(run.systemId);
	const staged = await queue.stagedUrls(run.systemId);
	const indexable = await queue.indexableUrls(run.systemId);
	const live = discoveredLive(staged, indexable);
	if (!incomplete && isStubGeneration(indexable.length)) {
		await writePark(env, run.systemId, indexable.length, iso);
		await queue.markDiscovered(run.systemId, iso);
		await writeIndexedHash(env, run.systemId, systemSeedHash(seed));
		await writeLastIndexedHashIfComplete(env);
		await queue.clearWork(run.systemId);
		await queue.clearRun(run.systemId);
		return { action: "parked", systemId: run.systemId, trigger: run.trigger, usable: indexable.length };
	}
	const itemsAuth = itemsAuthFrom(env, auth);
	const committed =
		indexable.length === 0
			? { pruned: [] as DroppedPage[] }
			: await commitDiscoveredUrls({
					queue,
					systemId: run.systemId,
					kind: run.kind,
					urls: indexable,
					liveUrls: live,
					ok: true,
					prune: !incomplete,
					now: iso,
					deleteDocs: (dropped) => deps.deleteDocs(itemsAuth, run.systemId, dropped, new Set(live)),
				});
	if (incomplete) {
		await queue.noteCapDefer(run.systemId, iso);
	} else {
		await queue.recordSeedRefresh(run.systemId, systemSeedHash(seed), iso);
		await queue.clearCapDefer(run.systemId);
	}
	await queue.clearRun(run.systemId);
	return {
		action: "enqueued",
		systemId: run.systemId,
		kind: run.kind,
		trigger: run.trigger,
		urls: indexable.length,
		pruned: committed.pruned.map((row) => row.url),
		hitLimit: false,
		incomplete,
	};
}

async function failOrFinish(
	env: WorkerEnv,
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	iso: string,
	error: string,
): Promise<DiscoverTickResult> {
	if (await queue.discoverResume(run.systemId)) {
		await queue.noteAttempt(run.systemId, run.startUrl);
		await cancelJob(auth, run, deps);
		return yieldDiscoverSlot(env, queue, auth, run, deps, iso, true);
	}
	if (await hasStagedPages(queue, run.systemId)) {
		await queue.noteAttempt(run.systemId, run.startUrl);
		await cancelJob(auth, run, deps);
		return finishDiscover(env, queue, auth, run, deps, iso, true);
	}
	return failDiscover(queue, auth, run, deps, iso, error);
}

async function hasStagedPages(queue: D1PageQueue, systemId: DiscoverRun["systemId"]): Promise<boolean> {
	if ((await queue.indexableCount(systemId)) > 0) {
		return true;
	}
	return (await queue.stagedUrls(systemId)).length > 0;
}

async function failDiscover(
	queue: D1PageQueue,
	auth: CrawlAuth,
	run: DiscoverRun,
	deps: DiscoverDeps,
	iso: string,
	error: string,
): Promise<DiscoverTickResult> {
	await cancelJob(auth, run, deps);
	await queue.noteCapDefer(run.systemId, iso);
	await queue.clearRun(run.systemId);
	return { action: "failed", systemId: run.systemId, trigger: run.trigger, error };
}

async function cancelJob(auth: CrawlAuth, run: DiscoverRun, deps: DiscoverDeps): Promise<void> {
	try {
		await deps.cancel(auth, run.jobId);
	} catch (cancelError) {
		console.log(
			JSON.stringify({
				event: "crawl_cancel_failed",
				system: run.systemId,
				error: startFailureMessage(cancelError),
			}),
		);
	}
}

function startFailureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function accountAuthFailure(error: unknown): boolean {
	const status = httpStatusOf(error);
	return status === 401 || status === 403;
}

function httpStatusOf(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("httpStatus" in error)) {
		return undefined;
	}
	const status = error.httpStatus;
	return typeof status === "number" ? status : undefined;
}

function crawlAuth(env: WorkerEnv): CrawlAuth | null {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		return null;
	}
	return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}

function itemsAuthFrom(_env: WorkerEnv, auth: CrawlAuth): ItemsAuth {
	return {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: INSTANCE_ID,
	};
}
