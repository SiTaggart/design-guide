import type { WorkerEnv } from "./index/ai-search.ts";
import { handleHealth } from "./serve/health.ts";
import { handleSearch } from "./serve/search.ts";

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") {
			return handleHealth(env);
		}
		if (url.pathname === "/v1/search") {
			return handleSearch(request, env, url);
		}
		return new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: { "content-type": "application/json; charset=utf-8" },
		});
	},
};
