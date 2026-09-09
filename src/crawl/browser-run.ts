import { CRAWL_DEPTH, CRAWL_LIMIT } from "../config/instance.ts";
import type { CrawlCounts, Seed } from "../config/types.ts";

export type CrawlRecord = {
	url: string;
	status: string;
	markdown?: string;
};

export type CrawlAuth = {
	accountId: string;
	apiToken: string;
};

export type CrawlRequestBody = {
	url: string;
	source: "all";
	limit: number;
	depth: number;
	formats: ["markdown"];
	render: boolean;
	crawlPurposes: ["search"];
	contentUse: "reference";
	options: {
		includeExternalLinks: false;
		includeSubdomains: boolean;
		includePatterns?: string[];
		excludePatterns?: string[];
	};
};

export type CrawlOutcome = {
	startUrl: string;
	status: string;
	counts: CrawlCounts;
	records: CrawlRecord[];
};

type CrawlJobResult = {
	status?: string;
	total?: unknown;
	finished?: unknown;
	records?: CrawlRecord[];
	cursor?: string | number | null;
};

type StartResult = { jobId: string } | { httpStatus: number; detail: string };

const POLL_INTERVAL_MS = 15_000;
const CLOUDFLARE_JOB_MAX_RUN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

function crawlUrl(accountId: string, jobId?: string): string {
	const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`;
	return jobId ? `${base}/${jobId}` : base;
}

async function cfJson(
	auth: CrawlAuth,
	url: string,
	init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
	const response = await fetch(url, {
		...init,
		headers: {
			authorization: `Bearer ${auth.apiToken}`,
			...(init?.body ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
	});
	const data = (await response.json()) as Record<string, unknown>;
	return { ok: response.ok, status: response.status, data };
}

function toCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function crawlRequestBody(seed: Seed, startUrl: string): CrawlRequestBody {
	return {
		url: startUrl,
		source: "all",
		limit: CRAWL_LIMIT,
		depth: CRAWL_DEPTH,
		formats: ["markdown"],
		render: seed.render ?? true,
		crawlPurposes: ["search"],
		contentUse: "reference",
		options: {
			includeExternalLinks: false,
			includeSubdomains: seed.includeSubdomains ?? false,
			...(seed.includePatterns?.length ? { includePatterns: seed.includePatterns } : {}),
			...(seed.excludePatterns?.length ? { excludePatterns: seed.excludePatterns } : {}),
		},
	};
}

export function hitCrawlLimit(
	outcome: Pick<CrawlOutcome, "status" | "counts">,
	indexed: number,
): boolean {
	return (
		outcome.status === "cancelled_due_to_limits" ||
		outcome.counts.finished === CRAWL_LIMIT ||
		indexed === CRAWL_LIMIT
	);
}

async function startCrawl(auth: CrawlAuth, seed: Seed, startUrl: string): Promise<StartResult> {
	const { ok, status, data } = await cfJson(auth, crawlUrl(auth.accountId), {
		method: "POST",
		body: JSON.stringify(crawlRequestBody(seed, startUrl)),
	});
	if (!ok) {
		return { httpStatus: status, detail: JSON.stringify(data.errors ?? data) };
	}
	const jobId = data.result;
	if (typeof jobId !== "string" || !jobId) {
		throw new Error(`crawl start for ${startUrl} returned no job id`);
	}
	return { jobId };
}

async function pollJob(auth: CrawlAuth, jobId: string): Promise<CrawlJobResult> {
	const { ok, status, data } = await cfJson(auth, `${crawlUrl(auth.accountId, jobId)}?limit=1`);
	if (!ok) {
		throw new Error(`crawl poll failed ${status}: ${JSON.stringify(data.errors ?? data)}`);
	}
	return (data.result ?? {}) as CrawlJobResult;
}

async function waitForJob(auth: CrawlAuth, jobId: string): Promise<CrawlJobResult> {
	const deadline = Date.now() + CLOUDFLARE_JOB_MAX_RUN_MS;
	let failures = 0;
	while (Date.now() < deadline) {
		try {
			const job = await pollJob(auth, jobId);
			if (job.status && job.status !== "running") {
				return job;
			}
			failures = 0;
		} catch (error) {
			failures += 1;
			if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`crawl ${jobId} still running at the poll deadline`);
}

async function* pageRecords(
	auth: CrawlAuth,
	jobId: string,
	recordStatus: string,
): AsyncGenerator<CrawlRecord[]> {
	let cursor: string | number | undefined;
	for (;;) {
		const query = new URL(crawlUrl(auth.accountId, jobId));
		query.searchParams.set("status", recordStatus);
		if (cursor !== undefined) {
			query.searchParams.set("cursor", String(cursor));
		}
		const { ok, status, data } = await cfJson(auth, query.toString());
		if (!ok) {
			throw new Error(`crawl results failed ${status}: ${JSON.stringify(data.errors ?? data)}`);
		}
		const result = (data.result ?? {}) as CrawlJobResult;
		yield result.records ?? [];
		const next = result.cursor;
		if (next === undefined || next === null || next === "" || next === cursor) {
			return;
		}
		cursor = next;
	}
}

async function countRecords(auth: CrawlAuth, jobId: string, recordStatus: string): Promise<number> {
	let count = 0;
	for await (const page of pageRecords(auth, jobId, recordStatus)) {
		count += page.length;
	}
	return count;
}

async function completedRecords(auth: CrawlAuth, jobId: string): Promise<CrawlRecord[]> {
	const byUrl = new Map<string, CrawlRecord>();
	for await (const page of pageRecords(auth, jobId, "completed")) {
		for (const record of page) {
			if (record.status === "completed" && record.markdown?.trim() && record.url.startsWith("https://")) {
				byUrl.set(record.url, record);
			}
		}
	}
	return [...byUrl.values()];
}

export async function crawlSeed(auth: CrawlAuth, seed: Seed): Promise<CrawlOutcome> {
	let startUrl = seed.startUrl;
	let started = await startCrawl(auth, seed, startUrl);
	if (
		"httpStatus" in started &&
		seed.fallbackStartUrl &&
		started.httpStatus >= 400 &&
		started.httpStatus < 600
	) {
		startUrl = seed.fallbackStartUrl;
		started = await startCrawl(auth, seed, startUrl);
	}
	if ("httpStatus" in started) {
		throw new Error(`crawl start for ${startUrl} failed ${started.httpStatus}: ${started.detail}`);
	}
	const job = await waitForJob(auth, started.jobId);
	return {
		startUrl,
		status: job.status ?? "unknown",
		counts: {
			total: toCount(job.total),
			finished: toCount(job.finished),
			skipped: await countRecords(auth, started.jobId, "skipped"),
			disallowed: await countRecords(auth, started.jobId, "disallowed"),
			errored: await countRecords(auth, started.jobId, "errored"),
		},
		records: await completedRecords(auth, started.jobId),
	};
}
