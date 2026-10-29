import { INSTANCE_ID, RETRIEVAL_CANDIDATES } from "../config/instance.ts";
import type { SearchChunk, SearchParams, SearchResponse } from "../config/types.ts";
import { mapChunks } from "../serve/map-chunks.ts";
import { selectCitations } from "../serve/select-citations.ts";

export type SystemFilter = string | { $nin: readonly string[] } | { $in: readonly string[] };

export type SearchCall = {
	query: string;
	ai_search_options: {
		query_rewrite: { enabled: false };
		reranking: { enabled: false };
		retrieval: {
			max_num_results: number;
			retrieval_type: "vector";
			filters?: { system: SystemFilter };
		};
	};
};

export type SearchInstance = {
	search(input: SearchCall): Promise<{ chunks?: SearchChunk[] }>;
	items: {
		list(options?: {
			page?: number;
			per_page?: number;
			status?: string;
		}): Promise<{ result: Array<{ status?: string }> }>;
	};
};

export type AiSearchNamespace = {
	get(id: string): SearchInstance;
};

export type WorkerEnv = {
	AI_SEARCH: AiSearchNamespace;
	INDEX?: KVNamespace;
	PAGE_QUEUE?: D1Database;
	REINDEX?: Workflow;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_API_TOKEN?: string;
	INDEX_WEBHOOK_URL?: string;
	EMAIL?: SendEmail;
	STATUS_TOKEN?: string;
};

function retrievalFilters(
	params: SearchParams,
	excludeSystems?: ReadonlySet<string>,
): { system: SystemFilter } | undefined {
	if (params.system) {
		return { system: params.system };
	}
	if (excludeSystems?.size) {
		return { system: { $nin: [...excludeSystems] } };
	}
	return undefined;
}

export async function searchCitations(
	env: WorkerEnv,
	params: SearchParams,
	excludeSystems?: ReadonlySet<string>,
): Promise<SearchResponse> {
	const instance = env.AI_SEARCH.get(INSTANCE_ID);
	const filters = retrievalFilters(params, excludeSystems);
	const result = await instance.search({
		query: params.query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				max_num_results: RETRIEVAL_CANDIDATES,
				retrieval_type: "vector",
				...(filters ? { filters } : {}),
			},
		},
	});
	const chunks = await withoutStaleCopies(env.PAGE_QUEUE, result.chunks ?? []);
	return { results: selectCitations(mapChunks(chunks), params.k) };
}

async function withoutStaleCopies(db: D1Database | undefined, chunks: readonly SearchChunk[]): Promise<SearchChunk[]> {
	if (!db || chunks.length === 0) {
		return [...chunks];
	}
	const urls: string[] = [];
	for (const chunk of chunks) {
		const url = chunk.item?.metadata?.source_url;
		if (typeof url === "string" && url && !urls.includes(url)) {
			urls.push(url);
		}
	}
	if (urls.length === 0) {
		return [...chunks];
	}
	const listed = await db
		.prepare(
			`SELECT url, content_hash FROM page_copy WHERE url IN (${urls.map(() => "?").join(", ")})`,
		)
		.bind(...urls)
		.all<{ url: string; content_hash: string }>();
	const live = new Map(listed.results.map((row) => [row.url, row.content_hash]));
	if (live.size === 0) {
		return [...chunks];
	}
	return chunks.filter((chunk) => {
		const url = chunk.item?.metadata?.source_url;
		if (typeof url !== "string" || !live.has(url)) {
			return true;
		}
		const hash = live.get(url);
		if (!hash) {
			return false;
		}
		return chunk.item?.metadata?.content_hash === hash;
	});
}

export async function indexHasCompletedItems(env: WorkerEnv): Promise<boolean> {
	try {
		const listed = await env.AI_SEARCH.get(INSTANCE_ID).items.list({
			page: 1,
			per_page: 1,
			status: "completed",
		});
		return listed.result.length > 0;
	} catch {
		return false;
	}
}
