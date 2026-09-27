import type { SearchCall, SystemFilter, WorkerEnv } from "../../src/index/ai-search.ts";
import type { SearchChunk } from "../../src/config/types.ts";
import type { ReindexParams } from "../../src/index/status.ts";

function matchesSystemFilter(system: unknown, filter?: SystemFilter): boolean {
	if (filter === undefined) {
		return true;
	}
	const value = typeof system === "string" ? system : "";
	if (typeof filter === "string") {
		return value === filter;
	}
	if ("$nin" in filter) {
		return !filter.$nin.includes(value);
	}
	return filter.$in.includes(value);
}

export function memoryKV(init: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
	const store = new Map(Object.entries(init));
	return {
		store,
		get: (async (key: string) => store.get(key) ?? null) as KVNamespace["get"],
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		list: (async () => ({
			keys: [...store.keys()].map((name) => ({ name })),
			list_complete: true,
			cacheStatus: null,
		})) as KVNamespace["list"],
		getWithMetadata: (async () => ({
			value: null,
			metadata: null,
			cacheStatus: null,
		})) as unknown as KVNamespace["getWithMetadata"],
	} as KVNamespace & { store: Map<string, string> };
}

export function mockWorkflow(options?: {
	existingStatus?: string;
	existingId?: string;
}): {
	created: Array<{ id?: string; params?: ReindexParams }>;
	binding: Workflow;
} {
	const created: Array<{ id?: string; params?: ReindexParams }> = [];
	const binding = {
		create: async (opts?: { id?: string; params?: ReindexParams }) => {
			created.push({ id: opts?.id, params: opts?.params });
			return {
				id: opts?.id ?? "wf-new",
				status: async () => ({ status: "running" as const }),
			};
		},
		get: async (id: string) => ({
			id,
			status: async () => ({
				status: (options?.existingId === id ? options.existingStatus : "complete") as "complete",
			}),
		}),
	};
	return { created, binding: binding as unknown as Workflow };
}

export function envWithIndex(
	chunks: SearchChunk[],
	ready = true,
	extra: Partial<WorkerEnv> = {},
): { env: WorkerEnv; calls: SearchCall[] } {
	const calls: SearchCall[] = [];
	return {
		calls,
		env: {
			AI_SEARCH: {
				get: () => ({
					search: async (input: SearchCall) => {
						calls.push(input);
						if (input.query.includes("no-such-passage")) {
							return { chunks: [] };
						}
						const limit = input.ai_search_options.retrieval.max_num_results;
						const matched = chunks.filter((chunk) =>
							matchesSystemFilter(
								chunk.item?.metadata?.system,
								input.ai_search_options.retrieval.filters?.system,
							),
						);
						return { chunks: matched.slice(0, limit) };
					},
					items: {
						list: async () => ({ result: ready ? [{ status: "completed" }] : [] }),
					},
				}),
			},
			...extra,
		},
	};
}
