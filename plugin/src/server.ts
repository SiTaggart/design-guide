const DEFAULT_BASE_URL = "https://design-guide.me-2c5.workers.dev";
const SERVER_NAME = "design-guide";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SYSTEMS = ["paste", "primer", "uswds", "govuk", "nhs", "antd", "gitlab-pajamas"] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Framing = "lsp" | "ndjson";
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
				enum: [...SYSTEMS],
				description: "Optional seed id",
			},
			k: {
				type: "integer",
				minimum: 1,
				maximum: 20,
				description: "Result count, 1-20",
			},
		},
		required: ["query"],
	},
};

function resolveBaseUrl(raw: string | undefined): string {
	const value = raw?.trim() ?? "";
	if (!value || value === "${DESIGN_GUIDE_BASE_URL}") {
		return DEFAULT_BASE_URL;
	}
	return value.replace(/\/+$/, "");
}

const BASE_URL = resolveBaseUrl(process.env.DESIGN_GUIDE_BASE_URL);

function asRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function skipSpace(buf: Uint8Array, start: number): number {
	let i = start;
	while (i < buf.length) {
		const c = buf[i];
		if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) {
			i += 1;
			continue;
		}
		break;
	}
	return i;
}

function asciiStartsWithCI(buf: Uint8Array, start: number, ascii: string): boolean | null {
	const available = buf.length - start;
	const n = Math.min(available, ascii.length);
	for (let i = 0; i < n; i++) {
		const c = buf[start + i] ?? 0;
		const expected = ascii.charCodeAt(i);
		if (c === expected) continue;
		if (expected >= 65 && expected <= 90 && c === expected + 32) continue;
		if (expected >= 97 && expected <= 122 && c === expected - 32) continue;
		return false;
	}
	if (available < ascii.length) return null;
	return true;
}

function findHeaderEnd(buf: Uint8Array, start: number): number {
	for (let i = start; i < buf.length - 1; i++) {
		if (
			buf[i] === 0x0d &&
			buf[i + 1] === 0x0a &&
			i + 3 < buf.length &&
			buf[i + 2] === 0x0d &&
			buf[i + 3] === 0x0a
		) {
			return i + 4;
		}
		if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
			return i + 2;
		}
	}
	return -1;
}

function indexOfByte(buf: Uint8Array, byte: number, start: number): number {
	for (let i = start; i < buf.length; i++) {
		if (buf[i] === byte) return i;
	}
	return -1;
}

function parseContentLength(header: string): number | null {
	const match = header.match(/content-length:\s*(\d+)/i);
	if (!match) return null;
	return Number(match[1]);
}

function tryReadMessage(
	buf: Uint8Array,
): { message: JsonRpcMessage; framing: Framing; rest: Uint8Array } | { skip: Uint8Array } | null {
	const start = skipSpace(buf, 0);
	if (start >= buf.length) return null;

	const lsp = asciiStartsWithCI(buf, start, "content-length:");
	if (lsp === null) return null;
	if (lsp) {
		const headerEnd = findHeaderEnd(buf, start);
		if (headerEnd === -1) return null;
		const length = parseContentLength(decoder.decode(buf.subarray(start, headerEnd)));
		if (length === null || !Number.isFinite(length) || length < 0) {
			return { skip: buf.subarray(headerEnd) };
		}
		if (buf.length < headerEnd + length) return null;
		const body = decoder.decode(buf.subarray(headerEnd, headerEnd + length));
		return {
			message: JSON.parse(body) as JsonRpcMessage,
			framing: "lsp",
			rest: buf.subarray(headerEnd + length),
		};
	}

	const first = buf[start];
	if (first !== 0x7b && first !== 0x5b) {
		return { skip: buf.subarray(start + 1) };
	}

	const nl = indexOfByte(buf, 0x0a, start);
	if (nl === -1) return null;
	const line = decoder.decode(buf.subarray(start, nl)).replace(/\r$/, "");
	if (!line) return { skip: buf.subarray(nl + 1) };
	return {
		message: JSON.parse(line) as JsonRpcMessage,
		framing: "ndjson",
		rest: buf.subarray(nl + 1),
	};
}

function writeMessage(message: unknown, framing: Framing): void {
	const json = JSON.stringify(message);
	if (framing === "lsp") {
		const body = encoder.encode(json);
		const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
		process.stdout.write(header);
		process.stdout.write(body);
		return;
	}
	process.stdout.write(encoder.encode(`${json}\n`));
}

function debug(message: string): void {
	process.stderr.write(`${message}\n`);
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string): void {
	if (id === undefined) return;
	writeMessage({ jsonrpc: "2.0", id, error: { code, message } }, currentFraming);
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): void {
	if (id === undefined) return;
	writeMessage({ jsonrpc: "2.0", id, result }, currentFraming);
}

async function searchDesignGuidance(args: Record<string, unknown>): Promise<ToolResult> {
	const payload: Record<string, unknown> = {};
	if (Object.hasOwn(args, "query")) payload.query = args.query;
	if (Object.hasOwn(args, "system")) payload.system = args.system;
	if (Object.hasOwn(args, "k")) payload.k = args.k;

	let response: Response;
	try {
		response = await fetch(`${BASE_URL}/v1/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text }], isError: true };
	}

	const body = await response.text();
	if (response.status >= 200 && response.status < 300) {
		return { content: [{ type: "text", text: body }] };
	}
	return {
		content: [{ type: "text", text: `${response.status} ${body}` }],
		isError: true,
	};
}

async function callTool(params: unknown): Promise<ToolResult> {
	const record = asRecord(params);
	if (record.name !== "search_design_guidance") {
		const error = new Error(`Unknown tool: ${String(record.name)}`);
		(error as Error & { code: number }).code = -32602;
		throw error;
	}
	return searchDesignGuidance(asRecord(record.arguments));
}

async function handleRequest(message: JsonRpcMessage): Promise<unknown> {
	const method = message.method ?? "";
	if (method === "initialize") {
		const requested = asRecord(message.params).protocolVersion;
		const protocolVersion =
			typeof requested === "string" &&
			(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
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
		return callTool(message.params);
	}
	const error = new Error(`Method not found: ${method}`);
	(error as Error & { code: number }).code = -32601;
	throw error;
}

let currentFraming: Framing = "ndjson";

async function dispatch(message: JsonRpcMessage, framing: Framing): Promise<void> {
	currentFraming = framing;
	const id = Object.hasOwn(message, "id") ? message.id : undefined;
	try {
		const result = await handleRequest(message);
		if (id === undefined) return;
		if (result !== undefined) rpcResult(id, result);
	} catch (error) {
		const code = typeof (error as { code?: unknown }).code === "number"
			? (error as { code: number }).code
			: -32603;
		const text = error instanceof Error ? error.message : String(error);
		debug(text);
		rpcError(id, code, text);
	}
}

async function main(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	let buffer = new Uint8Array(0);

	while (true) {
		const { done, value } = await reader.read();
		if (value) buffer = concatBytes(buffer, value);

		while (true) {
			let parsed: ReturnType<typeof tryReadMessage>;
			try {
				parsed = tryReadMessage(buffer);
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				debug(text);
				const start = skipSpace(buffer, 0);
				const nl = indexOfByte(buffer, 0x0a, start);
				buffer = nl === -1 ? new Uint8Array(0) : buffer.subarray(nl + 1);
				continue;
			}
			if (!parsed) break;
			if ("skip" in parsed) {
				buffer = parsed.skip;
				continue;
			}
			buffer = parsed.rest;
			await dispatch(parsed.message, parsed.framing);
		}

		if (done) {
			const leftover = decoder.decode(buffer.subarray(skipSpace(buffer, 0))).trim();
			if (leftover.startsWith("{") || leftover.startsWith("[")) {
				try {
					await dispatch(JSON.parse(leftover) as JsonRpcMessage, "ndjson");
				} catch (error) {
					debug(error instanceof Error ? error.message : String(error));
				}
			}
			break;
		}
	}
}

main().catch((error) => {
	debug(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
