import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { MAX_K, MIN_K } from "../config/instance.ts";
import { SYSTEM_IDS } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { parseSearchFields } from "./parse.ts";
import { resolveSearch, type SearchOutcome } from "./search.ts";

const SERVER_NAME = "design-guide";
const SERVER_VERSION = "0.1.0";

const MCP_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers":
		"content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
	"access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

const SEARCH_INPUT = z.object({
	query: z.string().describe("Search query"),
	system: z.enum(SYSTEM_IDS).optional().describe("Optional seed id"),
	k: z.number().int().min(MIN_K).max(MAX_K).optional().describe("Result count, 1-20"),
});

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

function createDesignGuideServer(env: WorkerEnv): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
	);
	server.registerTool(
		"search_design_guidance",
		{
			description:
				"Search indexed design-system docs and return cited passages. Never invent passages or scores.",
			inputSchema: SEARCH_INPUT,
		},
		async (args) => toolFromOutcome(await resolveSearch(env, parseSearchFields(args))),
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
	const handler = createMcpHandler(() => createDesignGuideServer(env));
	return withCors(await handler.fetch(request));
}
