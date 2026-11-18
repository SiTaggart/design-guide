import { createHash } from "node:crypto";
import { CRAWL_RUNAWAY_PAGES, INSTANCE_ID, MAX_ITEM_BYTES } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import { isSystemId, type CrawlCounts, type Seed, type SystemId } from "../config/types.ts";
import {
	crawlSeed,
	crawlStoppedEarly,
	reachedRunawayCeiling,
	type CrawlAuth,
	type CrawlOutcome,
	type CrawlRecord,
} from "../crawl/browser-run.ts";
import { admittedUrl, isLlmsIndexFile } from "../crawl/links.ts";
import {
	deleteItem,
	ensureInstance,
	listItems,
	uploadItem,
	type ItemRequestOptions,
	type ItemsAuth,
} from "./items-rest.ts";

export type ReindexAuth = CrawlAuth & { instanceId?: string };

export type SystemReindexResult = {
	system: SystemId;
	startUrl: string;
	crawl: CrawlCounts;
	indexed: number;
	hitLimit: boolean;
	keptPrevious: boolean;
	deleted?: number;
	error?: string;
	parked?: boolean;
	usable?: number;
	held?: boolean;
	incomplete?: boolean;
};

const EMPTY_COUNTS: CrawlCounts = { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 };

function itemKey(system: SystemId, generation: string, pageUrl: string): string {
	const digest = createHash("sha256").update(pageUrl).digest("hex").slice(0, 16);
	return `${system}/${generation}/${digest}.md`;
}

function generationId(now = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
}

export function swapGeneration(system: SystemId, durableId?: string, now = new Date()): string {
	if (!durableId) {
		return generationId(now);
	}
	return createHash("sha256").update(`${durableId}\0${system}`).digest("hex").slice(0, 16);
}

function isSystemGenerationKey(key: string, system: SystemId, generation: string): boolean {
	return key.startsWith(`${system}/${generation}/`);
}

export function fitsItem(record: CrawlRecord, seed: Seed): boolean {
	if (isLlmsIndexFile(record.url)) {
		return false;
	}
	const markdown = record.markdown ?? "";
	if (!markdown.trim() || new TextEncoder().encode(markdown).byteLength > MAX_ITEM_BYTES) {
		return false;
	}
	const suffixes = seed.indexUrlSuffixes;
	if (!suffixes?.length) {
		return true;
	}
	const path = record.url.split("?")[0] ?? "";
	return suffixes.some((suffix) => path.endsWith(suffix));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function deleteItems(
	auth: ItemsAuth,
	shouldDelete: (key: string) => boolean,
	options?: ItemRequestOptions,
): Promise<number> {
	let deleted = 0;
	for (const item of await listItems(auth, options)) {
		if (shouldDelete(item.key)) {
			await deleteItem(auth, item.id, options);
			deleted += 1;
		}
	}
	return deleted;
}

const CLEANUP_PASSES = 3;

async function deleteMatching(
	auth: ItemsAuth,
	shouldDelete: (key: string) => boolean,
	options?: ItemRequestOptions,
): Promise<void> {
	let lastError: unknown;
	for (let pass = 0; pass < CLEANUP_PASSES; pass += 1) {
		const pending = (await listItems(auth, options)).filter((item) => shouldDelete(item.key));
		if (pending.length === 0) {
			return;
		}
		lastError = undefined;
		for (const item of pending) {
			try {
				await deleteItem(auth, item.id, options);
			} catch (error) {
				lastError = error;
			}
		}
	}
	const left = (await listItems(auth, options)).some((item) => shouldDelete(item.key));
	if (!left) {
		return;
	}
	throw lastError instanceof Error ? lastError : new Error("generation cleanup left items");
}

export function isDroppedSystemKey(key: string): boolean {
	const prefix = key.split("/")[0] ?? "";
	return prefix !== "" && !isSystemId(prefix);
}

export async function deleteDroppedSystemItems(auth: ItemsAuth): Promise<number> {
	return deleteItems(auth, isDroppedSystemKey);
}

export function reindexFailure(seed: Seed, error: string): SystemReindexResult {
	return {
		system: seed.id,
		startUrl: seed.startUrl,
		crawl: EMPTY_COUNTS,
		indexed: 0,
		hitLimit: false,
		keptPrevious: true,
		usable: 0,
		error,
	};
}

function itemsAuthFrom(auth: ReindexAuth): ItemsAuth {
	return {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: auth.instanceId ?? INSTANCE_ID,
	};
}

type SwapDecision =
	| { action: "keep"; hitLimit: boolean; parked: boolean; incomplete?: boolean; error?: string }
	| { action: "commit"; incomplete?: boolean };

function swapDecision(input: {
	status: string;
	counts: CrawlCounts;
	usable: number;
	incomplete?: boolean;
}): SwapDecision {
	if (input.status !== "completed" && input.status !== "cancelled_due_to_limits") {
		return {
			action: "keep",
			hitLimit: false,
			parked: false,
			error: `crawl ended ${input.status}`,
		};
	}
	const incomplete =
		input.incomplete === true ||
		crawlStoppedEarly(input.status, input.counts.finished) ||
		reachedRunawayCeiling(input.usable);
	if (incomplete) {
		return {
			action: "keep",
			hitLimit: false,
			parked: false,
			incomplete: true,
		};
	}
	if (isStubGeneration(input.usable)) {
		return {
			action: "keep",
			hitLimit: false,
			parked: true,
			error: `stub: only ${input.usable} usable page(s)`,
		};
	}
	return { action: "commit" };
}

function keepResult(
	seed: Seed,
	startUrl: string,
	counts: CrawlCounts,
	usable: number,
	decision: Extract<SwapDecision, { action: "keep" }>,
	indexed = 0,
	keptPrevious = true,
): SystemReindexResult {
	return {
		system: seed.id,
		startUrl,
		crawl: counts,
		indexed,
		hitLimit: decision.hitLimit,
		keptPrevious,
		usable,
		...(decision.incomplete ? { incomplete: true } : {}),
		...(decision.parked ? { parked: true } : {}),
		...(decision.error ? { error: decision.error } : {}),
	};
}

function admittedRecords(records: readonly CrawlRecord[], seed: Seed): CrawlRecord[] {
	const byUrl = new Map<string, CrawlRecord>();
	for (const record of records) {
		const url = admittedUrl(record.url, seed);
		if (!url) {
			continue;
		}
		const normalized = { ...record, url };
		if (fitsItem(normalized, seed)) {
			byUrl.set(url, normalized);
		}
	}
	return [...byUrl.values()];
}

function indexableRecords(records: readonly CrawlRecord[], seed: Seed): CrawlRecord[] {
	return admittedRecords(
		records.filter((record) => record.status === "completed"),
		seed,
	);
}

async function uploadFittedRecords(
	auth: ReindexAuth,
	seed: Seed,
	generation: string,
	records: readonly CrawlRecord[],
	options?: ItemRequestOptions,
): Promise<void> {
	const itemsAuth = itemsAuthFrom(auth);
	for (const record of records) {
		await uploadItem(
			itemsAuth,
			itemKey(seed.id, generation, record.url),
			record.markdown ?? "",
			{
				system: seed.id,
				source: seed.source,
				source_url: record.url,
			},
			options,
		);
	}
}

async function releaseFailedGeneration(
	auth: ReindexAuth,
	system: SystemId,
	generation: string,
	options?: ItemRequestOptions,
): Promise<{ keptPrevious: boolean; indexed: number }> {
	const itemsAuth = itemsAuthFrom(auth);
	const items = await listItems(itemsAuth, options);
	const prefix = `${system}/${generation}/`;
	const prior = items.some((item) => item.key.startsWith(`${system}/`) && !item.key.startsWith(prefix));
	if (prior) {
		await deleteMatching(itemsAuth, (key) => key.startsWith(prefix), options);
	}
	return { keptPrevious: prior, indexed: 0 };
}

async function deleteGeneration(
	auth: ReindexAuth,
	system: SystemId,
	generation: string,
	options?: ItemRequestOptions,
): Promise<void> {
	await deleteMatching(
		itemsAuthFrom(auth),
		(key) => isSystemGenerationKey(key, system, generation),
		options,
	);
}

async function deletePreviousGeneration(
	auth: ReindexAuth,
	system: SystemId,
	generation: string,
	options?: ItemRequestOptions,
): Promise<number> {
	return deleteItems(
		itemsAuthFrom(auth),
		(key) => key.startsWith(`${system}/`) && !isSystemGenerationKey(key, system, generation),
		options,
	);
}

export async function swapFromOutcome(
	auth: ReindexAuth,
	seed: Seed,
	outcome: CrawlOutcome,
	options?: { generation?: string },
): Promise<SystemReindexResult> {
	const usable = admittedRecords(outcome.records, seed);
	const decision = swapDecision({
		status: outcome.status,
		counts: outcome.counts,
		usable: usable.length,
	});
	const generation = options?.generation ?? swapGeneration(seed.id);
	if (decision.action === "keep") {
		return keepResult(seed, outcome.startUrl, outcome.counts, usable.length, decision);
	}
	try {
		await uploadFittedRecords(auth, seed, generation, usable);
	} catch (error) {
		const released = await releaseFailedGeneration(auth, seed.id, generation);
		return {
			...keepResult(seed, outcome.startUrl, outcome.counts, usable.length, {
				action: "keep",
				hitLimit: false,
				parked: false,
				error: errorMessage(error),
			}),
			indexed: released.indexed,
			keptPrevious: released.keptPrevious,
		};
	}
	const deleted = await deletePreviousGeneration(auth, seed.id, generation);
	return {
		system: seed.id,
		startUrl: outcome.startUrl,
		crawl: outcome.counts,
		indexed: usable.length,
		hitLimit: false,
		keptPrevious: false,
		usable: usable.length,
		deleted,
	};
}

export async function reindexSystem(
	auth: ReindexAuth,
	seed: Seed,
): Promise<SystemReindexResult> {
	let outcome: CrawlOutcome;
	try {
		outcome = await crawlSeed(auth, seed);
	} catch (error) {
		return reindexFailure(seed, errorMessage(error));
	}
	return swapFromOutcome(auth, seed, outcome);
}

export async function reindex(
	auth: ReindexAuth,
	only?: SystemId,
): Promise<SystemReindexResult[]> {
	const itemsAuth: ItemsAuth = {
		accountId: auth.accountId,
		apiToken: auth.apiToken,
		instanceId: auth.instanceId ?? INSTANCE_ID,
	};
	await ensureInstance(itemsAuth);
	await deleteDroppedSystemItems(itemsAuth);
	const seeds = only ? [seedById(only)] : [...SEEDS];
	const results: SystemReindexResult[] = [];
	for (const seed of seeds) {
		results.push(await reindexSystem(auth, seed));
	}
	return results;
}

export function isStubGeneration(usable: number): boolean {
	return usable < 2;
}

export function reindexExitCode(results: readonly SystemReindexResult[]): 0 | 1 {
	if (results.some((result) => result.hitLimit || result.incomplete)) {
		return 1;
	}
	if (results.length > 0 && results.every((result) => result.indexed === 0)) {
		return 1;
	}
	return 0;
}
