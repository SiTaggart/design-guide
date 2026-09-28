import { createHash } from "node:crypto";
import { CRAWL_LIMIT, INSTANCE_ID, MAX_ITEM_BYTES } from "../config/instance.ts";
import { SEEDS, seedById } from "../config/seed.ts";
import { isSystemId, type CrawlCounts, type Seed, type SystemId } from "../config/types.ts";
import {
	crawlSeed,
	hitCrawlLimit,
	type CrawlAuth,
	type CrawlOutcome,
	type CrawlRecord,
} from "../crawl/browser-run.ts";
import {
	deleteItem,
	ensureInstance,
	listItems,
	isItemOverload,
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
	| { action: "keep"; hitLimit: boolean; parked: boolean; error: string }
	| { action: "commit" };

function swapDecision(input: {
	status: string;
	counts: CrawlCounts;
	usable: number;
	truncated?: boolean;
}): SwapDecision {
	const hitLimit =
		input.truncated === true ||
		hitCrawlLimit({ status: input.status, counts: input.counts }, input.usable);
	if (hitLimit) {
		return {
			action: "keep",
			hitLimit: true,
			parked: false,
			error: `crawl hit the ${CRAWL_LIMIT} page limit`,
		};
	}
	if (input.status !== "completed") {
		return {
			action: "keep",
			hitLimit: false,
			parked: false,
			error: `crawl ended ${input.status}`,
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
		...(decision.parked ? { parked: true } : {}),
		error: decision.error,
	};
}

function indexableRecords(records: readonly CrawlRecord[], seed: Seed): CrawlRecord[] {
	return records.filter(
		(record) => record.status === "completed" && record.url.startsWith("https://") && fitsItem(record, seed),
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
	const usable = outcome.records.filter((record) => fitsItem(record, seed));
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

export type CrawlPage = {
	records: CrawlRecord[];
	cursor: string | number | null;
};

type StoredUrl = { url: string; id: string };

type SwapStep = <T extends Rpc.Serializable<T>>(name: string, run: () => Promise<T>) => Promise<T>;

function failedStep(error: unknown, overloaded: boolean): { error: string; overloaded: boolean } {
	return { error: errorMessage(error), overloaded: overloaded || isItemOverload(error) };
}

export async function streamSwap(
	auth: ReindexAuth,
	seed: Seed,
	input: {
		startUrl: string;
		snapshot: { status: string; total: number; finished: number };
		generation: string;
		fetchPage: (cursor?: string | number) => Promise<CrawlPage>;
		countStatuses: () => Promise<CrawlCounts>;
		step?: SwapStep;
		onOverload?: () => void;
	},
): Promise<SystemReindexResult> {
	const step: SwapStep = input.step ?? (async (_name, run) => run());
	const rough: CrawlCounts = {
		total: input.snapshot.total,
		finished: input.snapshot.finished,
		skipped: 0,
		disallowed: 0,
		errored: 0,
	};
	const early = swapDecision({ status: input.snapshot.status, counts: rough, usable: 0 });
	if (early.action === "keep" && (early.hitLimit || input.snapshot.status !== "completed")) {
		const counts = await step(`counts-${seed.id}`, async () => {
			try {
				return await input.countStatuses();
			} catch {
				return rough;
			}
		});
		const decision = swapDecision({ status: input.snapshot.status, counts, usable: 0 });
		if (decision.action === "keep") {
			return keepResult(seed, input.startUrl, counts, 0, decision);
		}
	}

	let cursor: string | number | undefined;
	let seen: StoredUrl[] = [];
	let usable = 0;
	let page = 0;
	let truncated = false;
	for (;;) {
		const known = seen;
		const batch = await step(`upload-${seed.id}-${page}`, async () => {
			let overloaded = false;
			const options: ItemRequestOptions = {
				onOverload: () => {
					overloaded = true;
				},
			};
			try {
				const fetched = await input.fetchPage(cursor);
				const latest = new Map<string, CrawlRecord>();
				for (const record of indexableRecords(fetched.records, seed)) {
					latest.set(record.url, record);
				}
				const ids = new Map(known.map((item) => [item.url, item.id]));
				const stored: StoredUrl[] = [];
				let uploaded = 0;
				const itemsAuth = itemsAuthFrom(auth);
				for (const record of latest.values()) {
					const previous = ids.get(record.url);
					if (previous) {
						await deleteItem(itemsAuth, previous, options);
					} else {
						uploaded += 1;
					}
					const item = await uploadItem(
						itemsAuth,
						itemKey(seed.id, input.generation, record.url),
						record.markdown ?? "",
						{
							system: seed.id,
							source: seed.source,
							source_url: record.url,
						},
						options,
					);
					ids.set(record.url, item.id);
					stored.push({ url: record.url, id: item.id });
				}
				return {
					ok: true as const,
					uploaded,
					urls: stored,
					cursor: fetched.cursor,
					overloaded,
				};
			} catch (error) {
				return { ok: false as const, ...failedStep(error, overloaded) };
			}
		});
		if (batch.overloaded) {
			input.onOverload?.();
		}
		if (!batch.ok) {
			const released = await step(`abandon-${seed.id}`, async () => {
				let overloaded = false;
				try {
					const release = await releaseFailedGeneration(auth, seed.id, input.generation, {
						onOverload: () => {
							overloaded = true;
						},
					});
					return { ok: true as const, ...release, overloaded };
				} catch (error) {
					return { ok: false as const, ...failedStep(error, overloaded), keptPrevious: true, indexed: 0 };
				}
			});
			if (released.overloaded) {
				input.onOverload?.();
			}
			if (!released.ok) {
				return {
					system: seed.id,
					startUrl: input.startUrl,
					crawl: rough,
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable,
					error: released.error,
				};
			}
			const counts = await step(`counts-failed-${seed.id}`, async () => {
				try {
					return await input.countStatuses();
				} catch {
					return rough;
				}
			});
			return {
				system: seed.id,
				startUrl: input.startUrl,
				crawl: counts,
				indexed: released.indexed,
				hitLimit: false,
				keptPrevious: released.keptPrevious,
				usable,
				error: batch.error,
			};
		}
		const byUrl = new Map(seen.map((item) => [item.url, item.id]));
		for (const item of batch.urls) {
			byUrl.set(item.url, item.id);
		}
		seen = [...byUrl].map(([url, id]) => ({ url, id }));
		usable += batch.uploaded;
		page += 1;
		if (batch.cursor === null) {
			break;
		}
		if (page >= CRAWL_LIMIT) {
			truncated = true;
			break;
		}
		cursor = batch.cursor;
	}

	const committed = await step(`commit-${seed.id}`, async () => {
		let overloaded = false;
		const options: ItemRequestOptions = {
			onOverload: () => {
				overloaded = true;
			},
		};
		const counts = await input.countStatuses();
		const decision = swapDecision({
			status: input.snapshot.status,
			counts,
			usable,
			truncated,
		});
		if (decision.action === "keep") {
			try {
				await deleteGeneration(auth, seed.id, input.generation, options);
				return { kind: "keep" as const, counts, decision, overloaded };
			} catch (error) {
				return { kind: "cleanup-failed" as const, counts, ...failedStep(error, overloaded) };
			}
		}
		try {
			const deleted = await deletePreviousGeneration(auth, seed.id, input.generation, options);
			return { kind: "commit" as const, counts, deleted, overloaded };
		} catch (error) {
			return {
				kind: "commit-failed" as const,
				counts,
				...failedStep(error, overloaded),
			};
		}
	});
	if (committed.overloaded) {
		input.onOverload?.();
	}
	if (committed.kind === "keep") {
		return keepResult(seed, input.startUrl, committed.counts, usable, committed.decision);
	}
	if (committed.kind === "cleanup-failed") {
		return {
			system: seed.id,
			startUrl: input.startUrl,
			crawl: committed.counts,
			indexed: 0,
			hitLimit: false,
			keptPrevious: true,
			usable,
			held: true,
			error: committed.error,
		};
	}
	if (committed.kind === "commit-failed") {
		return {
			system: seed.id,
			startUrl: input.startUrl,
			crawl: committed.counts,
			indexed: 0,
			hitLimit: false,
			keptPrevious: false,
			usable,
			error: committed.error,
		};
	}
	return {
		system: seed.id,
		startUrl: input.startUrl,
		crawl: committed.counts,
		indexed: usable,
		hitLimit: false,
		keptPrevious: false,
		usable,
		deleted: committed.deleted,
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
	if (results.some((result) => result.hitLimit)) {
		return 1;
	}
	if (results.length > 0 && results.every((result) => result.indexed === 0)) {
		return 1;
	}
	return 0;
}
