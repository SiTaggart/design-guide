import { describe, expect, it } from "vitest";
import type { SearchCall, WorkerEnv } from "../src/index/ai-search.ts";
import type { SearchChunk } from "../src/config/types.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";

const GOLDEN_QUERY = "accessible combobox or listbox keyboard and focus guidance";

const fixtureCitations = [
	{
		passage:
			"ComboBox supports arrow keys, Enter to select, and Escape to close. Focus stays on the input while the listbox is open.",
		source: "Paste",
		url: "https://paste-dsys.com/",
		system: "paste",
		score: 0.81,
	},
	{
		passage:
			"Select keeps keyboard focus in the text input. Arrow keys move active descendant in the listbox without shifting DOM focus.",
		source: "Primer",
		url: "https://primer.style/product/components/select/react/accessibility",
		system: "primer",
		score: 0.72,
	},
	{
		passage:
			"USWDS combo box documents keyboard interaction for the input and listbox, including focus visible on the selected option.",
		source: "USWDS",
		url: "https://designsystem.digital.gov/components/combo-box/",
		system: "uswds",
		score: 0.65,
	},
];

function envWithIndex(chunks: SearchChunk[], ready = true): { env: WorkerEnv; calls: SearchCall[] } {
	const calls: SearchCall[] = [];
	return {
		calls,
		env: {
			AI_SEARCH: {
				get: () => ({
					search: async (input: SearchCall) => {
						calls.push(input);
						if (input.query.includes("no-such-passage")) {
							return { chunks: [] };
						}
						return { chunks };
					},
					items: {
						list: async () => ({ result: ready ? [{ status: "completed" }] : [] }),
					},
				}),
			},
		},
	};
}

async function mcpRpc(env: WorkerEnv, message: Record<string, unknown>): Promise<Response> {
	return worker.fetch(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify(message),
		}),
		env,
	);
}

function rpcResult(body: unknown): unknown {
	expect(body).toMatchObject({ jsonrpc: "2.0" });
	expect(body).not.toHaveProperty("error");
	return (body as { result: unknown }).result;
}

describe("streamable HTTP MCP on the search worker", () => {
	it("returns initialize, lists search_design_guidance, and treats notifications as 202", async () => {
		const { env } = envWithIndex(fixtureChunks);
		const initialized = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			},
		});
		expect(initialized.status).toBe(200);
		expect(initialized.headers.get("content-type")).toContain("application/json");
		expect(rpcResult(await initialized.json())).toEqual({
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "design-guide", version: "0.1.0" },
		});

		const notice = await mcpRpc(env, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
			params: {},
		});
		expect(notice.status).toBe(202);
		expect(await notice.text()).toBe("");

		const listed = await mcpRpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(listed.status).toBe(200);
		expect(rpcResult(await listed.json())).toEqual({
			tools: [
				{
					name: "search_design_guidance",
					description:
						"Search indexed design-system docs and return cited passages. Never invent passages or scores.",
					inputSchema: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							system: {
								type: "string",
								enum: ["paste", "primer", "uswds", "govuk", "nhs", "antd", "gitlab-pajamas"],
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
				},
			],
		});
	});

	it("returns the same citation JSON as POST /v1/search for the golden query", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const http = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN_QUERY, k: 8 }),
			}),
			env,
		);
		const mcp = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: GOLDEN_QUERY, k: 8 },
			},
		});
		expect(http.status).toBe(200);
		expect(mcp.status).toBe(200);
		const httpBody = await http.json();
		const tool = rpcResult(await mcp.json()) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(tool.isError).toBeUndefined();
		expect(tool.content).toEqual([{ type: "text", text: JSON.stringify(httpBody) }]);
		expect(JSON.parse(tool.content[0].text)).toEqual({ results: fixtureCitations });
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual(calls[1]);
		expect(calls[0].ai_search_options.query_rewrite).toEqual({ enabled: false });
	});

	it("returns a tool error for a missing query", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const response = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "search_design_guidance", arguments: { k: 4 } },
		});
		expect(response.status).toBe(200);
		expect(rpcResult(await response.json())).toEqual({
			content: [{ type: "text", text: JSON.stringify({ error: "query_required" }) }],
			isError: true,
		});
		expect(calls).toEqual([]);
	});

	it("returns empty results when the system is unknown or the index matches nothing", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const unknown = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: GOLDEN_QUERY, system: "bootstrap" },
			},
		});
		expect(rpcResult(await unknown.json())).toEqual({
			content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
		});
		expect(calls).toEqual([]);

		const miss = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: "no-such-passage" },
			},
		});
		expect(rpcResult(await miss.json())).toEqual({
			content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
		});
		expect(calls[0].query).toBe("no-such-passage");
	});

	it("drops a 0.59 hit from the tool text and keeps a 0.6 hit", async () => {
		const extra: SearchChunk[] = [
			{
				text: "just below",
				score: 0.59,
				item: {
					metadata: {
						system: "govuk",
						source: "GOV.UK",
						source_url: "https://design-system.service.gov.uk/",
					},
				},
			},
			{
				text: "boundary keep",
				score: 0.6,
				item: {
					metadata: {
						system: "nhs",
						source: "NHS",
						source_url: "https://service-manual.nhs.uk/",
					},
				},
			},
		];
		const { env } = envWithIndex([...fixtureChunks, ...extra]);
		const response = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: GOLDEN_QUERY },
			},
		});
		const tool = rpcResult(await response.json()) as {
			content: Array<{ text: string }>;
		};
		expect(JSON.parse(tool.content[0].text)).toEqual({
			results: [
				...fixtureCitations,
				{
					passage: "boundary keep",
					source: "NHS",
					url: "https://service-manual.nhs.uk/",
					system: "nhs",
					score: 0.6,
				},
			],
		});
	});

	it("returns a tool error when search cannot reach a ready index", async () => {
		const env: WorkerEnv = {
			AI_SEARCH: {
				get: () => ({
					search: async () => {
						throw new Error("instance missing");
					},
					items: { list: async () => ({ result: [] }) },
				}),
			},
		};
		const response = await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: "combobox" },
			},
		});
		expect(rpcResult(await response.json())).toEqual({
			content: [{ type: "text", text: JSON.stringify({ error: "index_not_ready" }) }],
			isError: true,
		});
	});

	it("returns 405 for GET /mcp and leaves POST /v1/search on the HTTP contract", async () => {
		const { env } = envWithIndex(fixtureChunks);
		const get = await worker.fetch(new Request("https://example.test/mcp"), env);
		expect(get.status).toBe(405);

		const search = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ k: 4 }),
			}),
			env,
		);
		expect(search.status).toBe(400);
		expect(await search.json()).toEqual({ error: "query_required" });
	});
});
