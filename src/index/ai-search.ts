import { INSTANCE_ID } from "../config/instance.ts";
import type { SearchChunk, SearchParams, SearchResponse } from "../config/types.ts";
import { mapChunks } from "../serve/map-chunks.ts";

export type SearchCall = {
	query: string;
	ai_search_options: {
		query_rewrite: { enabled: false };
		retrieval: {
			max_num_results: number;
			retrieval_type: "hybrid";
			keyword_match_mode: "or";
			filters?: { system: string };
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
};

export async function searchCitations(
	env: WorkerEnv,
	params: SearchParams,
): Promise<SearchResponse> {
	const instance = env.AI_SEARCH.get(INSTANCE_ID);
	const result = await instance.search({
		query: params.query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			retrieval: {
				max_num_results: params.k,
				retrieval_type: "hybrid",
				keyword_match_mode: "or",
				...(params.system ? { filters: { system: params.system } } : {}),
			},
		},
	});
	return { results: mapChunks(result.chunks ?? []) };
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
