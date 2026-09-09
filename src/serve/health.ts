import { indexHasCompletedItems, type WorkerEnv } from "../index/ai-search.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export async function handleHealth(env: WorkerEnv): Promise<Response> {
	const ready = await indexHasCompletedItems(env);
	if (!ready) {
		return new Response(JSON.stringify({ error: "index_not_ready" }), {
			status: 503,
			headers: JSON_HEADERS,
		});
	}
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: JSON_HEADERS,
	});
}
