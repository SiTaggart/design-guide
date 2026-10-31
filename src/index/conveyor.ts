import { INSTANCE_ID } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import { isSystemId, type Seed, type SystemId } from "../config/types.ts";
import { fetchPageMarkdown, type CrawlAuth } from "../crawl/browser-run.ts";
import { admittedUrl, frontierLinks, pageKey } from "../crawl/links.ts";
import { contentHash } from "./content-hash.ts";
import { D1PageQueue, DRAIN_LIMIT, FILL_TICK_DEADLINE_MS, MAX_ATTEMPTS } from "./page-queue.ts";
import { deleteItem, listItems, uploadItem, type ItemRecord, type ItemsAuth } from "./items-rest.ts";
import { pageItemKey } from "./drain.ts";
import { fitsItem } from "./reindex.ts";
import { reindexAuth } from "./trigger.ts";
import {
	isSitemapFile,
	expandSitemap,
} from "./refresh-delta.ts";
import { clearPark } from "./parks.ts";
import { clearRetrievalHold } from "./retrieval-hold.ts";
import { isWorkflowLive, readStoredStatus, writeStatus } from "./status.ts";
import { readMarks, writeMark, UrlQueue, type QueueRow } from "./url-queue.ts";
import type { WorkerEnv } from "./ai-search.ts";
export const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export type FetchedPage = {
	status: number;
	body: string;
};

export type ConveyorReport = {
	depth: number;
	oldestAgeMs: number | null;
	appended: number;
	indexed: number;
	unchanged: number;
	deleted: number;
	failed: number;
};

export type ConveyorDeps = {
	fetchText?: (url: string) => Promise<FetchedPage>;
	fetchPage?: (url: string) => Promise<FetchedPage>;
	listItems?: () => Promise<ItemRecord[]>;
	upload?: (input: { systemId: SystemId; url: string; markdown: string; hash: string; now: string }) => Promise<void>;
	deletePage?: (systemId: SystemId, url: string) => Promise<void>;
	limit?: number;
	deadlineMs?: number;
};

type Clock = { ms: number };

export function discoveryRows(seed: Seed): { url: string; op: "fetch" | "sitemap" }[] {
	const origin = new URL(seed.startUrl).origin;
	const start = admittedUrl(seed.startUrl, seed);
	const rows: { url: string; op: "fetch" | "sitemap" }[] = [];
	if (start) {
		rows.push({ url: start, op: "fetch" });
	}
	for (const url of [`${origin}/robots.txt`, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
		rows.push({ url, op: "sitemap" });
	}
	return rows;
}

export async function seedSystem(input: {
	queue: UrlQueue;
	seed: Seed;
	clock: Clock;
}): Promise<string[]> {
	const rows = discoveryRows(input.seed);
	await input.queue.enqueue(
		rows.map((row) => ({ url: row.url, systemId: input.seed.id, op: row.op })),
		input.clock,
	);
	return rows.map((row) => row.url);
}

export async function applyRefresh(input: {
	queue: UrlQueue;
	systemId: SystemId;
	seed: Seed;
	known: readonly string[];
	clock: Clock;
}): Promise<number> {
	const rows = discoveryRows(input.seed).filter((row) => row.op === "sitemap");
	const seen = new Set(rows.map((row) => row.url));
	for (const url of input.known) {
		if (!url || seen.has(url)) {
			continue;
		}
		seen.add(url);
		rows.push({ url, op: "fetch" });
	}
	return input.queue.enqueue(
		rows.map((row) => ({ url: row.url, systemId: input.systemId, op: row.op })),
		input.clock,
	);
}

export async function consumeQueue(input: {
	queue: UrlQueue;
	now: string;
	limit: number;
	clock: Clock;
	fetchPage: (url: string) => Promise<FetchedPage>;
	fetchText?: (url: string) => Promise<FetchedPage>;
	knownHashes: Map<string, string>;
	knownUrls: Set<string>;
	upload: (row: QueueRow, markdown: string, hash: string) => Promise<void>;
	deletePage: (systemId: SystemId, url: string) => Promise<void>;
	deadline?: number;
	retain?: (systemId: SystemId, url: string, hash: string) => Promise<void>;
	pages?: D1Database;
}): Promise<Pick<ConveyorReport, "indexed" | "unchanged" | "deleted" | "failed" | "appended"> & { systems: SystemId[] }> {
	const batch = await input.queue.takeOldest(input.limit);
	let indexed = 0;
	let unchanged = 0;
	let deleted = 0;
	let failed = 0;
	let appended = 0;
	const systems: SystemId[] = [];
	const deadline = input.deadline ?? Number.POSITIVE_INFINITY;
	const retain = input.retain ?? (async () => undefined);
	for (const row of batch) {
		if (Date.now() >= deadline) {
			break;
		}
		try {
			if (row.op === "sitemap") {
				appended += await expandQueuedSitemap(input.queue, row, input.fetchText, input.clock);
				continue;
			}
			if (row.op === "delete") {
				await input.queue.commitCopy(row.systemId, row.url, "");
				await input.deletePage(row.systemId, row.url);
				await input.queue.remove(row.url);
				await finishPage(input.pages, row, input.now, false);
				deleted += 1;
				continue;
			}
			const page = await input.fetchPage(row.url);
			if (page.status === 404 || page.status === 410) {
				await input.queue.commitCopy(row.systemId, row.url, "");
				await input.deletePage(row.systemId, row.url);
				await input.queue.remove(row.url);
				await finishPage(input.pages, row, input.now, false);
				deleted += 1;
				continue;
			}
			if (page.status !== 200) {
				const message = `fetch failed ${page.status}`;
				await input.queue.sendBack(row.url, stamp(input.clock), message);
				await noteFailure(input.pages, row, message);
				failed += 1;
				continue;
			}
			const seed = seedById(row.systemId);
			const hash = contentHash(page.body);
			const stored = input.knownHashes.get(`${row.systemId}\0${row.url}`);
			if (stored !== undefined && stored === hash) {
				await input.queue.commitCopy(row.systemId, row.url, hash);
				await retain(row.systemId, row.url, hash);
				appended += await appendLinks(input.queue, seed, row.url, page.body, input.knownUrls, input.clock);
				await input.queue.remove(row.url);
				await finishPage(input.pages, row, input.now, false);
				input.knownUrls.add(`${row.systemId}\0${row.url}`);
				unchanged += 1;
				continue;
			}
			if (!fitsItem({ url: row.url, status: "completed", markdown: page.body }, seed)) {
				await input.queue.remove(row.url);
				await finishPage(input.pages, row, input.now, false);
				continue;
			}
			await input.upload(row, page.body, hash);
			await input.queue.commitCopy(row.systemId, row.url, hash);
			await retain(row.systemId, row.url, hash);
			appended += await appendLinks(input.queue, seed, row.url, page.body, input.knownUrls, input.clock);
			await input.queue.remove(row.url);
			await finishPage(input.pages, row, input.now, true);
			input.knownUrls.add(`${row.systemId}\0${row.url}`);
			input.knownHashes.set(`${row.systemId}\0${row.url}`, hash);
			systems.push(row.systemId);
			indexed += 1;
		} catch (error) {
			const message = errorMessage(error);
			await input.queue.sendBack(row.url, stamp(input.clock), message);
			await noteFailure(input.pages, row, message);
			failed += 1;
		}
	}
	return { indexed, unchanged, deleted, failed, appended, systems };
}

async function expandQueuedSitemap(
	queue: UrlQueue,
	row: QueueRow,
	fetchText: ((url: string) => Promise<FetchedPage>) | undefined,
	clock: Clock,
): Promise<number> {
	if (!fetchText) {
		throw new Error("sitemap fetch is missing");
	}
	const page = await fetchText(row.url);
	if (page.status === 404 || page.status === 410) {
		await queue.remove(row.url);
		return 0;
	}
	if (page.status !== 200) {
		throw new Error(`fetch failed ${page.status}`);
	}
	const seed = seedById(row.systemId);
	const expanded = expandSitemap(page.body, (url) => admittedUrl(url, seed));
	const appended = await queue.enqueue(
		[
			...expanded.sitemaps.map((url) => ({ url, systemId: row.systemId, op: "sitemap" as const })),
			...expanded.pages.map((url) => ({ url, systemId: row.systemId, op: "fetch" as const })),
		],
		clock,
	);
	await queue.completeSitemap(row.url);
	return appended;
}

async function appendLinks(
	queue: UrlQueue,
	seed: Seed,
	pageUrl: string,
	markdown: string,
	knownUrls: ReadonlySet<string>,
	clock: Clock,
): Promise<number> {
	const links = frontierLinks(markdown, pageUrl, seed).filter((url) => !knownUrls.has(`${seed.id}\0${url}`) && !isSitemapFile(url));
	const fresh: string[] = [];
	for (const url of links) {
		if (!(await queue.has(url))) {
			fresh.push(url);
		}
	}
	return queue.enqueue(
		fresh.map((url) => ({ url, systemId: seed.id, op: "fetch" as const })),
		clock,
	);
}

function stamp(clock: Clock): string {
	const value = new Date(clock.ms).toISOString();
	clock.ms += 1;
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function copyPendingPageWork(db: D1Database): Promise<void> {
	await db
		.prepare(
			`INSERT INTO queue (url, system_id, enqueued_at, op)
			 SELECT url, system_id, enqueued_at, 'fetch'
			 FROM page_work
			 WHERE status = 'pending' OR status = 'claimed'
			 ON CONFLICT(url) DO NOTHING`,
		)
		.run();
}

async function settleStaleRun(env: WorkerEnv, now: Date): Promise<void> {
	const current = await readStoredStatus(env);
	if (current.state !== "running") {
		return;
	}
	if (await isWorkflowLive(env, current.workflowId)) {
		return;
	}
	await writeStatus(env, {
		...current,
		state: "ok",
		finishedAt: now.toISOString(),
	});
}

async function noteFailure(db: D1Database | undefined, row: QueueRow, error: string): Promise<void> {
	if (!db) {
		return;
	}
	await db
		.prepare(
			`UPDATE page_work
			 SET error = ?,
			     attempts = attempts + 1,
			     status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
			     claimed_at = NULL,
			     claim_token = NULL
			 WHERE system_id = ? AND url = ?`,
		)
		.bind(error, MAX_ATTEMPTS, row.systemId, row.url)
		.run();
}

async function finishPage(db: D1Database | undefined, row: QueueRow, now: string, indexed: boolean): Promise<void> {
	if (!db) {
		return;
	}
	await db
		.prepare(
			`INSERT INTO page_work (
			   system_id, url, kind, status, enqueued_at, attempts, last_crawled, last_indexed
			 ) VALUES (?, ?, 'reindex', 'done', ?, 0, ?, ?)
			 ON CONFLICT(system_id, url) DO UPDATE SET
			   status = 'done',
			   last_crawled = excluded.last_crawled,
			   last_indexed = CASE WHEN ? = 1 THEN excluded.last_indexed ELSE page_work.last_indexed END,
			   error = NULL,
			   claimed_at = NULL,
			   claim_token = NULL`,
		)
		.bind(row.systemId, row.url, now, now, indexed ? now : null, indexed ? 1 : 0)
		.run();
}

export function oldestAgeMs(enqueuedAt: string | null, nowMs: number): number | null {
	if (!enqueuedAt) {
		return null;
	}
	return Math.max(0, nowMs - Date.parse(enqueuedAt));
}

export async function conveyorTick(
	env: WorkerEnv,
	cron: string,
	now = new Date(),
	deps: ConveyorDeps = {},
): Promise<ConveyorReport | undefined> {
	if (!env.PAGE_QUEUE) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "unbound" }));
		return;
	}
	const auth = reindexAuth(env);
	if (!auth) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "no-auth" }));
		return;
	}
	const db = env.PAGE_QUEUE;
	const queue = new UrlQueue(db);
	const holder = new D1PageQueue(db);
	const owner = crypto.randomUUID();
	let held = false;
	try {
		held = await holder.claimFillLease(owner, now.toISOString());
	} catch (error) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "lease", error: errorMessage(error) }));
		return;
	}
	if (!held) {
		console.log(JSON.stringify({ event: "index_cron_skip", cron, reason: "fill-lease" }));
		return;
	}
	try {
		return await runConveyor({ env, auth, db, queue, cron, now, deps });
	} finally {
		try {
			await holder.releaseFillLease(owner);
		} catch (error) {
			console.log(JSON.stringify({ event: "fill_lease_release_failed", error: errorMessage(error) }));
		}
	}
}

async function runConveyor(input: {
	env: WorkerEnv;
	auth: CrawlAuth;
	db: D1Database;
	queue: UrlQueue;
	cron: string;
	now: Date;
	deps: ConveyorDeps;
}): Promise<ConveyorReport | undefined> {
	const { env, auth, db, queue, cron, now, deps } = input;
	await settleStaleRun(env, now);
	const clock: Clock = { ms: now.getTime() };
	const fetchText = deps.fetchText ?? fetchPlain;
	const fetchPage = deps.fetchPage ?? ((url: string) => fetchRenderedPage(auth, url));
	const deadline = deps.deadlineMs ?? Date.now() + FILL_TICK_DEADLINE_MS;
	const items = await loadItems(auth, deps.listItems);
	const known = items ? indexItems(items) : new Map<string, { hash: string }>();
	let appended = 0;

	const marks = await readMarks(db);
	for (const seed of SEEDS) {
		if (Date.now() >= deadline) {
			break;
		}
		const mark = marks.get(seed.id);
		if (mark?.lastDiscovered) {
			continue;
		}
		const rows = discoveryRows(seed);
		appended += await queue.enqueue(
			rows.map((row) => ({ url: row.url, systemId: seed.id, op: row.op })),
			clock,
		);
		await writeMark(db, seed.id, { lastDiscovered: now.toISOString() });
	}

	if (items) {
		appended += await refreshDue({
			db,
			queue,
			now,
			clock,
			known,
			deadline,
		});
	}

	await copyPendingPageWork(db);
	const knownHashes = new Map<string, string>();
	const knownUrls = new Set<string>();
	for (const [key, page] of known) {
		knownHashes.set(key, page.hash);
		knownUrls.add(key);
	}
	const consumed = items
		? await consumeQueue({
				queue,
				now: now.toISOString(),
				limit: deps.limit ?? DRAIN_LIMIT,
				clock,
				fetchPage,
				fetchText,
				knownHashes,
				knownUrls,
				deadline,
				pages: db,
				upload: async (row, markdown, hash) => {
					if (deps.upload) {
						await deps.upload({
							systemId: row.systemId,
							url: row.url,
							markdown,
							hash,
							now: now.toISOString(),
						});
						return;
					}
					await uploadIndexedPage(auth, row, markdown, hash, now.toISOString());
				},
				deletePage: deps.deletePage ?? ((systemId, url) => deleteStoredPage(auth, items, systemId, url)),
				retain: async (systemId, url, hash) => {
					await deleteOtherCopies(auth, items, systemId, url, hash);
				},
			})
		: { indexed: 0, unchanged: 0, deleted: 0, failed: 0, appended: 0, systems: [] as SystemId[] };
	appended += consumed.appended;
	for (const systemId of new Set(consumed.systems)) {
		await clearPark(env, systemId);
		await clearRetrievalHold(env, systemId);
	}

	const depth = await queue.depth();
	const oldest = await queue.oldest();
	const age = oldestAgeMs(oldest?.enqueuedAt ?? null, now.getTime());
	const report: ConveyorReport = {
		depth,
		oldestAgeMs: age,
		appended,
		indexed: consumed.indexed,
		unchanged: consumed.unchanged,
		deleted: consumed.deleted,
		failed: consumed.failed,
	};
	console.log(JSON.stringify({ event: "index_queue", cron, ...report }));
	return report;
}

async function refreshDue(input: {
	db: D1Database;
	queue: UrlQueue;
	now: Date;
	clock: Clock;
	known: Map<string, { hash: string }>;
	deadline: number;
}): Promise<number> {
	const marks = await readMarks(input.db);
	let appended = 0;
	for (const seed of SEEDS) {
		if (Date.now() >= input.deadline) {
			break;
		}
		const mark = marks.get(seed.id);
		if (!mark?.lastDiscovered) {
			continue;
		}
		if (input.now.getTime() - Date.parse(mark.lastDiscovered) < REFRESH_MS) {
			continue;
		}
		const collected = knownPages(input.known, seed.id);
		appended += await applyRefresh({
			queue: input.queue,
			systemId: seed.id,
			seed,
			known: collected,
			clock: input.clock,
		});
		await writeMark(input.db, seed.id, { lastDiscovered: input.now.toISOString() });
	}
	return appended;
}

function knownPages(known: Map<string, { hash: string }>, systemId: SystemId): string[] {
	const prefix = `${systemId}\0`;
	const urls: string[] = [];
	for (const key of known.keys()) {
		if (key.startsWith(prefix)) {
			urls.push(key.slice(prefix.length));
		}
	}
	return urls;
}

function indexItems(items: readonly ItemRecord[]): Map<string, { hash: string }> {
	const known = new Map<string, { hash: string }>();
	for (const item of items) {
		const system = item.metadata?.system;
		const source = item.metadata?.source_url;
		if (typeof system !== "string" || !isSystemId(system) || typeof source !== "string") {
			continue;
		}
		const hash = item.metadata?.content_hash;
		known.set(`${system}\0${pageKey(source)}`, { hash: typeof hash === "string" ? hash : "" });
	}
	return known;
}

async function loadItems(auth: CrawlAuth, override: ConveyorDeps["listItems"]): Promise<ItemRecord[] | null> {
	if (override) {
		return override();
	}
	try {
		return await listItems({ ...auth, instanceId: INSTANCE_ID });
	} catch (error) {
		console.log(JSON.stringify({ event: "index_items_unread", error: errorMessage(error) }));
		return null;
	}
}

async function uploadIndexedPage(
	auth: CrawlAuth,
	row: QueueRow,
	markdown: string,
	hash: string,
	now: string,
): Promise<void> {
	const seed = seedById(row.systemId);
	const itemsAuth: ItemsAuth = { ...auth, instanceId: INSTANCE_ID };
	const key = pageItemKey(row.systemId, row.url, 1, now);
	await uploadItem(itemsAuth, key, markdown, {
		system: seed.id,
		source: seed.source,
		source_url: row.url,
		content_hash: hash,
		lastCrawled: now,
		lastIndexed: now,
	});
}

async function deleteOtherCopies(
	auth: CrawlAuth,
	items: readonly ItemRecord[],
	systemId: SystemId,
	url: string,
	keepHash: string,
): Promise<void> {
	const itemsAuth: ItemsAuth = { ...auth, instanceId: INSTANCE_ID };
	for (const item of items) {
		if (item.metadata?.system !== systemId) {
			continue;
		}
		const source = item.metadata?.source_url;
		if (typeof source !== "string" || pageKey(source) !== url) {
			continue;
		}
		const hash = item.metadata?.content_hash;
		if (hash === keepHash) {
			continue;
		}
		await deleteItem(itemsAuth, item.id);
	}
}

async function deleteStoredPage(
	auth: CrawlAuth,
	items: readonly ItemRecord[],
	systemId: SystemId,
	url: string,
	keepKey?: string,
): Promise<void> {
	const itemsAuth: ItemsAuth = { ...auth, instanceId: INSTANCE_ID };
	for (const item of items) {
		if (item.key === keepKey || item.metadata?.system !== systemId) {
			continue;
		}
		const source = item.metadata?.source_url;
		if (typeof source !== "string" || pageKey(source) !== url) {
			continue;
		}
		await deleteItem(itemsAuth, item.id);
	}
}

async function fetchPlain(url: string): Promise<FetchedPage> {
	const response = await fetch(url, { redirect: "follow" });
	return { status: response.status, body: await response.text() };
}

async function fetchRenderedPage(auth: CrawlAuth, url: string): Promise<FetchedPage> {
	const response = await fetch(url, { redirect: "follow" });
	if (response.status !== 200) {
		return { status: response.status, body: "" };
	}
	const body = await fetchPageMarkdown(auth, url);
	return { status: 200, body };
}
