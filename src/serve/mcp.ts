import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { MAX_K, MIN_K } from "../config/instance.ts";
import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { liveSystemIds, readParks } from "../index/parks.ts";
import { parseSearchFields } from "./parse.ts";
import { parkedFromLive, resolveSearch, type SearchOutcome } from "./search.ts";

const SERVER_NAME = "design-guide";
const SERVER_VERSION = "0.1.0";

const MCP_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers":
		"content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
	"access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function searchInput(live: SystemId[]) {
	const fields = {
		query: z.string().describe("Search query"),
		k: z.number().int().min(MIN_K).max(MAX_K).optional().describe("Result count, 1-20"),
	};
	if (live.length === 0) {
		return z.object(fields);
	}
	return z.object({
		...fields,
		system: z.enum(live as [SystemId, ...SystemId[]]).optional().describe("Optional seed id"),
	});
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function toolFromOutcome(outcome: SearchOutcome): ToolResult {
	if (outcome.kind === "query_required") {
		return {
			content: [{ type: "text", text: JSON.stringify({ error: "query_required" }) }],
			isError: true,
		};
	}
	if (outcome.kind === "empty") {
		return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
	}
	if (outcome.kind === "ok") {
		return { content: [{ type: "text", text: JSON.stringify(outcome.body) }] };
	}
	return {
		content: [{ type: "text", text: JSON.stringify({ error: "index_not_ready" }) }],
		isError: true,
	};
}

function createDesignGuideServer(env: WorkerEnv, live: Set<SystemId>): McpServer {
	const liveIds = [...live];
	const parked = parkedFromLive(live);
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
	);
	server.registerTool(
		"search_design_guidance",
		{
			description:
				"Search indexed design-system docs and return cited passages. Never invent passages or scores.",
			inputSchema: searchInput(liveIds),
		},
		async (args) =>
			toolFromOutcome(await resolveSearch(env, parseSearchFields(args, live), parked)),
	);
	return server;
}

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(MCP_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function handleMcp(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: MCP_HEADERS });
	}
	const parksRead = await readParks(env);
	if (parksRead.kind === "unread") {
		return withCors(
			new Response(JSON.stringify({ error: "index_not_ready" }), {
				status: 503,
				headers: { "content-type": "application/json; charset=utf-8" },
			}),
		);
	}
	const live = new Set(liveSystemIds(parksRead.parks));
	const handler = createMcpHandler(() => createDesignGuideServer(env, live));
	return withCors(await handler.fetch(request));
}
