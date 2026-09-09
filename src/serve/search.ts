import type { WorkerEnv } from "../index/ai-search.ts";
import { searchCitations } from "../index/ai-search.ts";
import { parseSearchRequest } from "./parse.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export async function handleSearch(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response(JSON.stringify({ error: "method_not_allowed" }), {
			status: 405,
			headers: JSON_HEADERS,
		});
	}
	const parsed = await parseSearchRequest(request, url);
	if (parsed.kind === "query_required") {
		return new Response(JSON.stringify({ error: "query_required" }), {
			status: 400,
			headers: JSON_HEADERS,
		});
	}
	if (parsed.kind === "empty") {
		return new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: JSON_HEADERS,
		});
	}
	try {
		const body = await searchCitations(env, parsed.params);
		return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
	} catch {
		return new Response(JSON.stringify({ error: "index_not_ready" }), {
			status: 503,
			headers: JSON_HEADERS,
		});
	}
}
