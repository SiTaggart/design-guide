import type { SearchResponse } from "../config/types.ts";
import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { searchCitations } from "../index/ai-search.ts";
import { liveSystemIds, readParks } from "../index/parks.ts";
import { parseSearchRequest, type ParseResult } from "./parse.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export type SearchOutcome =
	| { kind: "query_required" }
	| { kind: "empty" }
	| { kind: "ok"; body: SearchResponse }
	| { kind: "index_not_ready" };

export function parkedFromLive(live: ReadonlySet<SystemId>): Set<string> {
	return new Set(SYSTEM_IDS.filter((id) => !live.has(id)));
}

export async function resolveSearch(
	env: WorkerEnv,
	parsed: ParseResult,
	parked?: ReadonlySet<string>,
): Promise<SearchOutcome> {
	if (parsed.kind === "query_required" || parsed.kind === "empty") {
		return parsed;
	}
	try {
		const requested = parsed.params.k;
		const body = await searchCitations(env, parsed.params, parked);
		if (!parked?.size) {
			return { kind: "ok", body };
		}
		return {
			kind: "ok",
			body: {
				results: body.results.filter((hit) => !parked.has(hit.system)).slice(0, requested),
			},
		};
	} catch {
		return { kind: "index_not_ready" };
	}
}

function searchHttpResponse(outcome: SearchOutcome): Response {
	if (outcome.kind === "query_required") {
		return new Response(JSON.stringify({ error: "query_required" }), {
			status: 400,
			headers: JSON_HEADERS,
		});
	}
	if (outcome.kind === "empty") {
		return new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: JSON_HEADERS,
		});
	}
	if (outcome.kind === "ok") {
		return new Response(JSON.stringify(outcome.body), {
			status: 200,
			headers: JSON_HEADERS,
		});
	}
	return new Response(JSON.stringify({ error: "index_not_ready" }), {
		status: 503,
		headers: JSON_HEADERS,
	});
}

export async function handleSearch(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response(JSON.stringify({ error: "method_not_allowed" }), {
			status: 405,
			headers: JSON_HEADERS,
		});
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		return searchHttpResponse({ kind: "index_not_ready" });
	}
	const live = new Set(liveSystemIds(parksRead.parks));
	return searchHttpResponse(
		await resolveSearch(env, await parseSearchRequest(request, url, live), parkedFromLive(live)),
	);
}
