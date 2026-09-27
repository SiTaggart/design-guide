import type { WorkerEnv } from "../index/ai-search.ts";
import { emptyStatus, readStatus } from "../index/status.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export async function handleIndexStatus(env: WorkerEnv): Promise<Response> {
	if (!env.INDEX) {
		return new Response(JSON.stringify(emptyStatus(true)), {
			status: 200,
			headers: JSON_HEADERS,
		});
	}
	return new Response(JSON.stringify(await readStatus(env)), {
		status: 200,
		headers: JSON_HEADERS,
	});
}
