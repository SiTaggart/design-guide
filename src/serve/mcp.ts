import { MAX_K, MIN_K } from "../config/instance.ts";
import { SYSTEM_IDS } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { parseSearchFields } from "./parse.ts";
import { resolveSearch, type SearchOutcome } from "./search.ts";

const SERVER_NAME = "design-guide";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const MCP_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers":
		"content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
	"access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
};
type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

const SEARCH_TOOL = {
	name: "search_design_guidance",
	description:
		"Search indexed design-system docs and return cited passages. Never invent passages or scores.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Search query",
			},
			system: {
				type: "string",
				enum: [...SYSTEM_IDS],
				description: "Optional seed id",
			},
			k: {
				type: "integer",
				minimum: MIN_K,
				maximum: MAX_K,
				description: "Result count, 1-20",
			},
		},
		required: ["query"],
	},
};

function asRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function isSupportedProtocol(value: string): boolean {
	return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function jsonRpcResponse(id: JsonRpcId | undefined, payload: { result?: unknown; error?: unknown }): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload }), {
		status: 200,
		headers: MCP_HEADERS,
	});
}

function accepted(): Response {
	return new Response(null, { status: 202, headers: MCP_HEADERS });
}

function isJsonRpcId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

function invalidRequest(id: JsonRpcId): Response {
	return jsonRpcResponse(id, { error: { code: -32600, message: "Invalid Request" } });
}

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

async function searchDesignGuidance(
	env: WorkerEnv,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	return toolFromOutcome(await resolveSearch(env, parseSearchFields(args)));
}

async function callTool(env: WorkerEnv, params: unknown): Promise<ToolResult> {
	const record = asRecord(params);
	if (record.name !== "search_design_guidance") {
		const error = new Error(`Unknown tool: ${String(record.name)}`);
		(error as Error & { code: number }).code = -32602;
		throw error;
	}
	return searchDesignGuidance(env, asRecord(record.arguments));
}

async function handleJsonRpc(env: WorkerEnv, message: JsonRpcMessage): Promise<unknown> {
	const method = message.method ?? "";
	if (method === "initialize") {
		const requested = asRecord(message.params).protocolVersion;
		const protocolVersion =
			typeof requested === "string" && isSupportedProtocol(requested)
				? requested
				: DEFAULT_PROTOCOL_VERSION;
		return {
			protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
		};
	}
	if (method === "notifications/initialized" || method === "initialized") {
		return undefined;
	}
	if (method === "ping") {
		return {};
	}
	if (method === "tools/list") {
		return { tools: [SEARCH_TOOL] };
	}
	if (method === "tools/call") {
		return callTool(env, message.params);
	}
	const error = new Error(`Method not found: ${method}`);
	(error as Error & { code: number }).code = -32601;
	throw error;
}

async function dispatchOne(env: WorkerEnv, raw: unknown): Promise<Response | null> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return invalidRequest(null);
	}
	const message = raw as JsonRpcMessage;
	const rawId = Object.hasOwn(message, "id") ? message.id : undefined;
	const id = isJsonRpcId(rawId) ? rawId : undefined;
	if (message.jsonrpc !== "2.0") {
		return invalidRequest(id ?? null);
	}
	if (rawId !== undefined && id === undefined) {
		return invalidRequest(null);
	}
	const isRequest = id !== undefined;
	try {
		const result = await handleJsonRpc(env, message);
		if (!isRequest) {
			return null;
		}
		return jsonRpcResponse(id, { result });
	} catch (error) {
		const code =
			typeof (error as { code?: unknown }).code === "number"
				? (error as { code: number }).code
				: -32603;
		const text = error instanceof Error ? error.message : String(error);
		if (!isRequest) {
			return null;
		}
		return jsonRpcResponse(id, { error: { code, message: text } });
	}
}

export async function handleMcp(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: MCP_HEADERS });
	}
	if (request.method === "GET" || request.method === "DELETE") {
		return new Response(null, {
			status: 405,
			headers: { ...MCP_HEADERS, allow: "POST, OPTIONS" },
		});
	}
	if (request.method !== "POST") {
		return new Response(JSON.stringify({ error: "method_not_allowed" }), {
			status: 405,
			headers: MCP_HEADERS,
		});
	}
	const protocolHeader = request.headers.get("mcp-protocol-version");
	if (protocolHeader && !isSupportedProtocol(protocolHeader)) {
		return new Response("Bad Request", { status: 400, headers: MCP_HEADERS });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonRpcResponse(null, { error: { code: -32700, message: "Parse error" } });
	}
	if (Array.isArray(body)) {
		if (body.length === 0) {
			return invalidRequest(null);
		}
		const replies: unknown[] = [];
		for (const item of body) {
			const response = await dispatchOne(env, item);
			if (response) {
				replies.push(await response.json());
			}
		}
		if (replies.length === 0) {
			return accepted();
		}
		return new Response(JSON.stringify(replies), { status: 200, headers: MCP_HEADERS });
	}
	const response = await dispatchOne(env, body);
	return response ?? accepted();
}
