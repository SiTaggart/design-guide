import { INSTANCE_ID } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import { isSystemId, type Seed, type SystemId } from "../config/types.ts";
import { fetchPageMarkdown, type CrawlAuth } from "../crawl/browser-run.ts";
import { admittedUrl, frontierLinks, pageKey } from "../crawl/links.ts";
import { contentHash } from "./content-hash.ts";
import { D1PageQueue, DRAIN_LIMIT, FILL_TICK_DEADLINE_MS } from "./page-queue.ts";
import { deleteItem, listItems, uploadItem, type ItemRecord, type ItemsAuth } from "./items-rest.ts";
import { pageItemKey } from "./drain.ts";
import { fitsItem } from "./reindex.ts";
import { reindexAuth } from "./trigger.ts";
import {
	isSitemapFile,
	isSitemapIndex,
	refreshDelta,
	robotsSitemaps,
	sitemapLocs,
	urlsToSeed,
	type KnownPage,
} from "./refresh-delta.ts";
import { clearPark } from "./parks.ts";
import { clearRetrievalHold } from "./retrieval-hold.ts";
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

export async function discoverPageUrls(
	seed: Seed,
	fetchText: (url: string) => Promise<FetchedPage>,
	fetchPage: (url: string) => Promise<FetchedPage>,
	deadline = Number.POSITIVE_INFINITY,
): Promise<{ urls: string[]; finished: boolean }> {
	const collected = await collectSitemapLocs(seed, fetchText, deadline);
	let links: string[] = [];
	let finished = collected.finished;
	if (finished && Date.now() < deadline) {
		try {
			const page = await fetchPage(seed.startUrl);
			if (page.status === 200 && page.body.trim()) {
				links = frontierLinks(page.body, seed.startUrl, seed);
			}
		} catch {
			links = [];
		}
	} else if (Date.now() >= deadline) {
		finished = false;
	}
	return {
		urls: urlsToSeed({
			startUrl: seed.startUrl,
			sitemapLocs: collected.locs,
			pageLinks: links,
			admit: (url) => admittedUrl(url, seed),
		}),
		finished,
	};
}

async function collectSitemapLocs(
	seed: Seed,
	fetchText: (url: string) => Promise<FetchedPage>,
	deadline: number,
): Promise<{ locs: string[]; finished: boolean }> {
	const origin = new URL(seed.startUrl).origin;
	const pending = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
	try {
		const robots = await fetchText(`${origin}/robots.txt`);
		if (robots.status === 200) {
			pending.push(...robotsSitemaps(robots.body));
		}
	} catch {
		// Leave the sitemap list as the origin defaults when robots.txt cannot be read.
	}
	const locs: string[] = [];
	const seen = new Set<string>();
	while (pending.length > 0) {
		if (Date.now() >= deadline) {
			return { locs, finished: false };
		}
		const next = pending.pop();
		if (!next || seen.has(next)) {
			continue;
		}
		seen.add(next);
		let page: FetchedPage;
		try {
			page = await fetchText(next);
		} catch {
			continue;
		}
		if (page.status !== 200) {
			continue;
		}
		const found = sitemapLocs(page.body);
		if (isSitemapIndex(page.body)) {
			pending.push(...found);
			continue;
		}
		locs.push(...found);
	}
	return { locs, finished: true };
}

export async function seedSystem(input: {
	queue: UrlQueue;
	seed: Seed;
	fetchText: (url: string) => Promise<FetchedPage>;
	fetchPage: (url: string) => Promise<FetchedPage>;
	clock: Clock;
}): Promise<string[]> {
	const found = await discoverPageUrls(input.seed, input.fetchText, input.fetchPage);
	await input.queue.enqueue(
		found.urls.map((url) => ({ url, systemId: input.seed.id, op: "fetch" as const })),
		input.clock,
	);
	return found.urls;
}

export async function applyRefresh(input: {
	queue: UrlQueue;
	systemId: SystemId;
	discovered: readonly string[];
	known: readonly KnownPage[];
	bodies: ReadonlyMap<string, string>;
	clock: Clock;
}): Promise<{ fetch: string[]; delete: string[]; appended: number }> {
	const delta = refreshDelta({
		discovered: input.discovered,
		known: input.known,
		bodies: input.bodies,
	});
	const appended = await input.queue.enqueue(
		[
			...delta.fetch.map((url) => ({ url, systemId: input.systemId, op: "fetch" as const })),
			...delta.delete.map((url) => ({ url, systemId: input.systemId, op: "delete" as const })),
		],
		input.clock,
	);
	return { fetch: delta.fetch, delete: delta.delete, appended };
}

export async function consumeQueue(input: {
	queue: UrlQueue;
	now: string;
	limit: number;
	clock: Clock;
	fetchPage: (url: string) => Promise<FetchedPage>;
	knownHashes: Map<string, string>;
	knownUrls: Set<string>;
	upload: (row: QueueRow, markdown: string, hash: string) => Promise<void>;
	deletePage: (systemId: SystemId, url: string) => Promise<void>;
	deadline?: number;
	dropExtras?: (systemId: SystemId, url: string) => Promise<void>;
}): Promise<Pick<ConveyorReport, "indexed" | "unchanged" | "deleted" | "failed" | "appended"> & { systems: SystemId[] }> {
	const batch = await input.queue.takeOldest(input.limit);
	let indexed = 0;
	let unchanged = 0;
	let deleted = 0;
	let failed = 0;
	let appended = 0;
	const systems: SystemId[] = [];
	const deadline = input.deadline ?? Number.POSITIVE_INFINITY;
	for (const row of batch) {
		if (Date.now() >= deadline) {
			break;
		}
		try {
			if (row.op === "delete") {
				await input.deletePage(row.systemId, row.url);
				await input.queue.remove(row.url);
				deleted += 1;
				continue;
			}
			const page = await input.fetchPage(row.url);
			if (page.status === 404 || page.status === 410) {
				await input.deletePage(row.systemId, row.url);
				await input.queue.remove(row.url);
				deleted += 1;
				continue;
			}
			if (page.status !== 200) {
				await input.queue.sendBack(row.url, stamp(input.clock), `fetch failed ${page.status}`);
				failed += 1;
				continue;
			}
			const seed = seedById(row.systemId);
			const hash = contentHash(page.body);
			const stored = input.knownHashes.get(`${row.systemId}\0${row.url}`);
			if (stored !== undefined && stored === hash) {
				if (input.dropExtras) {
					await input.dropExtras(row.systemId, row.url);
				}
				appended += await appendLinks(input.queue, seed, row.url, page.body, input.knownUrls, input.clock);
				await input.queue.remove(row.url);
				input.knownUrls.add(`${row.systemId}\0${row.url}`);
				unchanged += 1;
				continue;
			}
			if (!fitsItem({ url: row.url, status: "completed", markdown: page.body }, seed)) {
				await input.queue.remove(row.url);
				continue;
			}
			await input.upload(row, page.body, hash);
			appended += await appendLinks(input.queue, seed, row.url, page.body, input.knownUrls, input.clock);
			await input.queue.remove(row.url);
			input.knownUrls.add(`${row.systemId}\0${row.url}`);
			input.knownHashes.set(`${row.systemId}\0${row.url}`, hash);
			systems.push(row.systemId);
			indexed += 1;
		} catch (error) {
			await input.queue.sendBack(row.url, stamp(input.clock), errorMessage(error));
			failed += 1;
		}
	}
	return { indexed, unchanged, deleted, failed, appended, systems };
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
		const found = await discoverPageUrls(seed, fetchText, fetchPage, deadline);
		appended += await queue.enqueue(
			found.urls.map((url) => ({ url, systemId: seed.id, op: "fetch" as const })),
			clock,
		);
		if (found.finished) {
			await writeMark(db, seed.id, { lastDiscovered: now.toISOString(), offset: 0, after: null });
		}
	}

	if (items) {
		appended += await refreshDue({
			db,
			queue,
			now,
			clock,
			fetchText,
			fetchPage,
			known,
			deadline,
		});
	}

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
				knownHashes,
				knownUrls,
				deadline,
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
					await uploadIndexedPage(auth, items, row, markdown, hash, now.toISOString());
				},
				deletePage: deps.deletePage ?? ((systemId, url) => deleteStoredPage(auth, items, systemId, url)),
				dropExtras:
					deps.deletePage === undefined
						? async (systemId, url) => {
								await deleteExtraCopies(auth, items, systemId, url);
							}
						: undefined,
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
	fetchText: (url: string) => Promise<FetchedPage>;
	fetchPage: (url: string) => Promise<FetchedPage>;
	known: Map<string, { hash: string }>;
	deadline: number;
}): Promise<number> {
	const marks = await readMarks(input.db);
	const due = SEEDS.filter((seed) => {
		const mark = marks.get(seed.id);
		if (!mark?.lastDiscovered) {
			return false;
		}
		if (mark.after) {
			return true;
		}
		return input.now.getTime() - Date.parse(mark.lastDiscovered) >= REFRESH_MS;
	});
	const scans = new Map<SystemId, { urls: string[]; after: string | null; discovered: string[]; diffed: boolean }>();
	for (const seed of due) {
		if (Date.now() >= input.deadline) {
			break;
		}
		const mark = marks.get(seed.id);
		const found = await discoverPageUrls(seed, input.fetchText, input.fetchPage, input.deadline);
		const known = knownPages(input.known, seed.id);
		scans.set(seed.id, {
			urls: known.map((page) => page.url).sort(),
			after: mark?.after ?? null,
			discovered: found.urls,
			diffed: mark?.after != null,
		});
	}
	let appended = 0;
	let pending = true;
	while (pending && Date.now() < input.deadline) {
		pending = false;
		for (const seed of due) {
			const scan = scans.get(seed.id);
			if (!scan || Date.now() >= input.deadline) {
				continue;
			}
			const known = knownPages(input.known, seed.id);
			if (!scan.diffed) {
				const applied = await applyRefresh({
					queue: input.queue,
					systemId: seed.id,
					discovered: scan.discovered,
					known,
					bodies: new Map(),
					clock: input.clock,
				});
				appended += applied.appended;
				scan.diffed = true;
			}
			if (scan.urls.every((url) => scan.after !== null && url <= scan.after)) {
				await writeMark(input.db, seed.id, { lastDiscovered: input.now.toISOString(), offset: 0, after: null });
				scans.delete(seed.id);
				continue;
			}
			const url = scan.urls.find((candidate) => scan.after === null || candidate > scan.after) ?? "";
			let page: FetchedPage;
			try {
				page = await input.fetchPage(url);
			} catch (error) {
				appended += await input.queue.enqueue([{ url, systemId: seed.id, op: "fetch" }], input.clock);
				scan.after = url;
				await writeMark(input.db, seed.id, {
					lastDiscovered: marks.get(seed.id)?.lastDiscovered ?? input.now.toISOString(),
					offset: 0,
					after: url,
				});
				pending = true;
				console.log(JSON.stringify({ event: "refresh_fetch_failed", system: seed.id, url, error: errorMessage(error) }));
				continue;
			}
			if (page.status === 200) {
				const knownHash = known.find((entry) => entry.url === url)?.hash;
				if (knownHash === undefined || contentHash(page.body) !== knownHash) {
					appended += await input.queue.enqueue([{ url, systemId: seed.id, op: "fetch" }], input.clock);
				}
			} else if (page.status === 404 || page.status === 410) {
				appended += await input.queue.enqueue([{ url, systemId: seed.id, op: "delete" }], input.clock);
			} else {
				appended += await input.queue.enqueue([{ url, systemId: seed.id, op: "fetch" }], input.clock);
			}
			scan.after = url;
			const more = scan.urls.some((candidate) => candidate > url);
			if (!more) {
				await writeMark(input.db, seed.id, { lastDiscovered: input.now.toISOString(), offset: 0, after: null });
				scans.delete(seed.id);
			} else {
				await writeMark(input.db, seed.id, {
					lastDiscovered: marks.get(seed.id)?.lastDiscovered ?? input.now.toISOString(),
					offset: 0,
					after: url,
				});
				pending = true;
			}
		}
	}
	return appended;
}

function knownPages(known: Map<string, { hash: string }>, systemId: SystemId): KnownPage[] {
	const pages: KnownPage[] = [];
	for (const [key, page] of known) {
		const prefix = `${systemId}\0`;
		if (!key.startsWith(prefix)) {
			continue;
		}
		pages.push({ url: key.slice(prefix.length), hash: page.hash });
	}
	return pages;
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
	items: ItemRecord[],
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
	await deleteStoredPage(auth, items, row.systemId, row.url, key);
}

async function deleteExtraCopies(
	auth: CrawlAuth,
	items: readonly ItemRecord[],
	systemId: SystemId,
	url: string,
): Promise<void> {
	const matches = items.filter((item) => {
		if (item.metadata?.system !== systemId) {
			return false;
		}
		const source = item.metadata?.source_url;
		return typeof source === "string" && pageKey(source) === url;
	});
	const itemsAuth: ItemsAuth = { ...auth, instanceId: INSTANCE_ID };
	for (const item of matches.slice(1)) {
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
