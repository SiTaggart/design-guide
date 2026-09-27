import { describe, expect, it } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";
import { liveSystemIds, loadLiveSystemIds, readParks, writePark } from "../src/index/parks.ts";
import { parseSearchFields } from "../src/serve/parse.ts";
import worker from "../src/worker.ts";

async function mcpRpc(env: Parameters<typeof worker.fetch>[1], body: unknown): Promise<unknown> {
	const response = await worker.fetch(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		}),
		env,
	);
	const text = await response.text();
	const frames = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter(Boolean);
	return JSON.parse(frames.at(-1) || text);
}

const GOLDEN = "accessible combobox or listbox keyboard and focus guidance";

describe("park state", () => {
	it("treats a missing INDEX as an empty park map and the full live set", async () => {
		const { env } = envWithIndex(fixtureChunks);
		expect(await readParks(env)).toEqual({});
		expect(await loadLiveSystemIds(env)).toEqual(new Set(SYSTEM_IDS));
		expect(liveSystemIds({})).toEqual([...SYSTEM_IDS]);
	});

	it("writes a stub park that parse and HTTP search treat as unknown", async () => {
		const kv = memoryKV();
		const { env, calls } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		expect(await readParks(env)).toEqual({
			garden: { reason: "stub", usable: 1, at: "2026-09-27T00:00:00.000Z" },
		});
		expect(parseSearchFields({ query: "focus", system: "garden" }, await loadLiveSystemIds(env))).toEqual({
			kind: "empty",
		});
		expect(parseSearchFields({ query: "focus", system: "primer" }, await loadLiveSystemIds(env))).toMatchObject({
			kind: "ok",
			params: { system: "primer" },
		});

		const filtered = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN, system: "garden" }),
			}),
			env,
		);
		expect(filtered.status).toBe(200);
		expect(await filtered.json()).toEqual({ results: [] });
		expect(calls).toEqual([]);
	});

	it("drops parked-system citations from an unfiltered search", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "paste", 0);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN }),
			}),
			env,
		);
		const body = (await response.json()) as { results: Array<{ system: string }> };
		expect(body.results.map((hit) => hit.system)).toEqual(["primer", "uswds"]);
	});

	it("does not let parked hits consume k before the live filter", async () => {
		const kv = memoryKV();
		const { env, calls } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "paste", 0);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN, k: 1 }),
			}),
			env,
		);
		const body = (await response.json()) as { results: Array<{ system: string }> };
		expect(calls[0]?.ai_search_options.retrieval.max_num_results).toBe(2);
		expect(body.results.map((hit) => hit.system)).toEqual(["primer"]);
	});

	it("excludes a parked system from the MCP skill enum", async () => {
		const kv = memoryKV();
		const { env, calls } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1);
		const listed = (await mcpRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			result: { tools: Array<{ inputSchema: { properties?: { system?: { enum?: string[] } } } }> };
		};
		expect(listed.result.tools[0]?.inputSchema.properties?.system?.enum).toEqual(
			SYSTEM_IDS.filter((id) => id !== "garden"),
		);
		const called = (await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: GOLDEN, system: "garden" },
			},
		})) as { result: { isError?: boolean } };
		expect(called.result.isError).toBe(true);
		expect(calls).toEqual([]);
	});
});
