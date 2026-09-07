import { DEFAULT_K, MAX_K, MIN_K } from "../config/instance.ts";
import { isSystemId, type SearchParams, type SystemId } from "../config/types.ts";

export type ParseOk = { kind: "ok"; params: SearchParams };
export type ParseEmpty = { kind: "empty" };
export type ParseMissing = { kind: "query_required" };
export type ParseResult = ParseOk | ParseEmpty | ParseMissing;

type BodyFields = {
	query?: unknown;
	k?: unknown;
	system?: unknown;
};

function clampK(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) {
		return DEFAULT_K;
	}
	return Math.min(MAX_K, Math.max(MIN_K, Math.trunc(n)));
}

function readSystem(value: unknown): SystemId | "unknown" | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string") {
		return "unknown";
	}
	return isSystemId(value) ? value : "unknown";
}

export function parseSearchFields(fields: BodyFields): ParseResult {
	const query = typeof fields.query === "string" ? fields.query.trim() : "";
	if (!query) {
		return { kind: "query_required" };
	}
	const system = readSystem(fields.system);
	if (system === "unknown") {
		return { kind: "empty" };
	}
	return {
		kind: "ok",
		params: {
			query,
			k: clampK(fields.k),
			system,
		},
	};
}

export async function parseSearchRequest(request: Request, url: URL): Promise<ParseResult> {
	const fromQuery: BodyFields = {
		query: url.searchParams.get("query") ?? undefined,
		k: url.searchParams.get("k") ?? undefined,
		system: url.searchParams.get("system") ?? undefined,
	};
	if (request.method === "GET") {
		return parseSearchFields(fromQuery);
	}
	if (request.method !== "POST") {
		return { kind: "query_required" };
	}
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return parseSearchFields(fromQuery);
	}
	try {
		const body = (await request.json()) as BodyFields;
		return parseSearchFields({
			query: body.query ?? fromQuery.query,
			k: body.k ?? fromQuery.k,
			system: body.system ?? fromQuery.system,
		});
	} catch {
		return { kind: "query_required" };
	}
}
