import type { Seed } from "../config/types.ts";

export type CrawlRecord = {
	url: string;
	status: string;
	markdown?: string;
};

export type CrawlAuth = {
	accountId: string;
	apiToken: string;
};

type CrawlJobResult = {
	status?: string;
	records?: CrawlRecord[];
	cursor?: string | number;
};

const TERMINAL = new Set([
	"completed",
	"errored",
	"cancelled_due_to_timeout",
	"cancelled_due_to_limits",
	"cancelled_by_user",
]);

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

export async function startCrawl(
	auth: CrawlAuth,
	seed: Seed,
	startUrl: string,
): Promise<string> {
	const body = {
		url: startUrl,
		limit: seed.limit,
		depth: seed.depth,
		source: "links",
		formats: ["markdown"],
		render: seed.render ?? true,
		crawlPurposes: ["search"],
		contentUse: "reference",
		options: {
			includeExternalLinks: false,
			includeSubdomains: seed.includeSubdomains ?? false,
			includePatterns: seed.includePatterns,
			...(seed.excludePatterns ? { excludePatterns: seed.excludePatterns } : {}),
		},
		rejectResourceTypes: ["image", "media", "font", "websocket"],
	};
	const { ok, status, data } = await cfJson(auth, crawlUrl(auth.accountId), {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (!ok) {
		throw new Error(`crawl start failed ${status}: ${JSON.stringify(data.errors ?? data)}`);
	}
	const jobId = data.result;
	if (typeof jobId !== "string" || !jobId) {
		throw new Error("crawl start returned no job id");
	}
	return jobId;
}

async function waitForJob(auth: CrawlAuth, jobId: string): Promise<void> {
	const maxAttempts = 120;
	const delayMs = 5000;
	for (let i = 0; i < maxAttempts; i++) {
		const { ok, data } = await cfJson(
			auth,
			`${crawlUrl(auth.accountId, jobId)}?limit=1`,
		);
		const result = (data.result ?? {}) as CrawlJobResult;
		if (!ok) {
			throw new Error(`crawl poll failed: ${JSON.stringify(data.errors ?? data)}`);
		}
		if (result.status && result.status !== "running") {
			if (result.status !== "completed") {
				throw new Error(`crawl ${jobId} ended ${result.status}`);
			}
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`crawl ${jobId} timed out`);
}

async function collectRecords(auth: CrawlAuth, jobId: string): Promise<CrawlRecord[]> {
	const records: CrawlRecord[] = [];
	let cursor: string | number | undefined;
	for (;;) {
		const query = new URL(crawlUrl(auth.accountId, jobId));
		query.searchParams.set("status", "completed");
		query.searchParams.set("limit", "50");
		if (cursor !== undefined) {
			query.searchParams.set("cursor", String(cursor));
		}
		const { ok, data } = await cfJson(auth, query.toString());
		if (!ok) {
			throw new Error(`crawl results failed: ${JSON.stringify(data.errors ?? data)}`);
		}
		const result = (data.result ?? {}) as CrawlJobResult;
		if (!TERMINAL.has(result.status ?? "") && result.status !== undefined) {
			throw new Error(`crawl ${jobId} not terminal: ${result.status}`);
		}
		for (const record of result.records ?? []) {
			records.push(record);
		}
		if (result.cursor === undefined || result.cursor === null || result.cursor === "") {
			break;
		}
		cursor = result.cursor;
	}
	return records;
}

export async function crawlSeedUrls(
	auth: CrawlAuth,
	seed: Seed,
	startUrls: string[],
): Promise<CrawlRecord[]> {
	const byUrl = new Map<string, CrawlRecord>();
	for (const startUrl of startUrls) {
		const jobId = await startCrawl(auth, seed, startUrl);
		await waitForJob(auth, jobId);
		for (const record of await collectRecords(auth, jobId)) {
			if (record.status === "completed" && record.markdown?.trim() && record.url.startsWith("https://")) {
				byUrl.set(record.url, record);
			}
		}
	}
	return [...byUrl.values()];
}
