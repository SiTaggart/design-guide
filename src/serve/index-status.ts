import type { WorkerEnv } from "../index/ai-search.ts";
import { emptyStatus, readStatus, type IndexStatusDocument } from "../index/status.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** One overlay read: KV last-run plus live queue depths, freshness, and discover. */
export async function readIndexOverlay(env: WorkerEnv): Promise<IndexStatusDocument> {
	if (!env.INDEX) {
		return emptyStatus(true);
	}
	return readStatus(env);
}

export async function handleIndexStatus(env: WorkerEnv): Promise<Response> {
	return new Response(JSON.stringify(await readIndexOverlay(env)), {
		status: 200,
		headers: JSON_HEADERS,
	});
}
