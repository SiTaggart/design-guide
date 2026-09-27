import type { WorkerEnv } from "./index/ai-search.ts";
import { handleScheduled } from "./schedule.ts";
import { handleHealth } from "./serve/health.ts";
import { handleIndexStatus } from "./serve/index-status.ts";
import { handleMcp } from "./serve/mcp.ts";
import { handleSearch } from "./serve/search.ts";
import { ReindexWorkflow } from "./workflows/reindex.ts";

export { ReindexWorkflow };

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET") {
			return handleHealth(env);
		}
		if (url.pathname === "/v1/index-status" && request.method === "GET") {
			return handleIndexStatus(env);
		}
		if (url.pathname === "/v1/search") {
			return handleSearch(request, env, url);
		}
		if (url.pathname === "/mcp") {
			return handleMcp(request, env);
		}
		return new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: { "content-type": "application/json; charset=utf-8" },
		});
	},
	async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
		await handleScheduled(controller, env);
	},
};
