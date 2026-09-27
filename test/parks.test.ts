import { describe, expect, it } from "vitest";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV, parksKvGetRaw, parksKvGetThrows } from "./helpers/index-env.ts";
import { liveSystemIds, loadLiveSystemIds, PARKS_KEY, readParks, writePark } from "../src/index/parks.ts";
import { persistSystemOutcome } from "../src/index/trigger.ts";
import { startStatusRun } from "../src/index/status.ts";
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
		expect(await readParks(env)).toEqual({ kind: "ok", parks: {} });
		expect(await loadLiveSystemIds(env)).toEqual(new Set(SYSTEM_IDS));
		expect(liveSystemIds({})).toEqual([...SYSTEM_IDS]);
	});

	it("writes a stub park that parse and HTTP search treat as unknown", async () => {
		const kv = memoryKV();
		const { env, calls } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		expect(await readParks(env)).toEqual({
			kind: "ok",
			parks: { garden: { reason: "stub", usable: 1, at: "2026-09-27T00:00:00.000Z" } },
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

	it("excludes parked systems at retrieval so they do not consume k", async () => {
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
		expect(calls[0]?.ai_search_options.retrieval.max_num_results).toBe(1);
		expect(calls[0]?.ai_search_options.retrieval.filters).toEqual({ system: { $nin: ["paste"] } });
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

	it("omits the system enum when every seed is parked", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		for (const id of SYSTEM_IDS) {
			await writePark(env, id, 0);
		}
		const listed = (await mcpRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			result: { tools: Array<{ inputSchema: { properties?: { system?: { enum?: string[] } } } }> };
		};
		expect(listed.result.tools[0]?.inputSchema.properties?.system).toBeUndefined();
	});

	it("returns a parked system to search and MCP after persist clears the park", async () => {
		const gardenChunk = {
			text: "Garden combobox keeps keyboard focus in the input while the listbox is open.",
			score: 0.84,
			item: {
				key: "garden/gen/dddd.md",
				metadata: {
					system: "garden",
					source: "Garden",
					source_url: "https://garden.zendesk.com/",
				},
			},
		};
		const kv = memoryKV();
		const { env, calls } = envWithIndex([gardenChunk], true, { INDEX: kv });
		await writePark(env, "garden", 1);
		const parked = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN, system: "garden" }),
			}),
			env,
		);
		expect(parked.status).toBe(200);
		expect(await parked.json()).toEqual({ results: [] });
		expect(calls).toEqual([]);
		await startStatusRun(env, { trigger: "recovery", workflowId: "reindex-recovery-live" });
		await persistSystemOutcome(env, {
			system: "garden",
			startUrl: "https://garden.zendesk.com/",
			crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 2,
			hitLimit: false,
			keptPrevious: false,
			parked: false,
			usable: 2,
		});
		expect(parseSearchFields({ query: "focus", system: "garden" }, await loadLiveSystemIds(env))).toEqual({
			kind: "ok",
			params: { query: "focus", k: 8, system: "garden" },
		});
		const searched = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN, system: "garden" }),
			}),
			env,
		);
		expect(searched.status).toBe(200);
		expect(await searched.json()).toEqual({
			results: [
				{
					passage: "Garden combobox keeps keyboard focus in the input while the listbox is open.",
					source: "Garden",
					url: "https://garden.zendesk.com/",
					system: "garden",
					score: 0.84,
				},
			],
		});
		const listed = (await mcpRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			result: { tools: Array<{ inputSchema: { properties?: { system?: { enum?: string[] } } } }> };
		};
		expect(listed.result.tools[0]?.inputSchema.properties?.system?.enum).toEqual([...SYSTEM_IDS]);
		const called = (await mcpRpc(env, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "search_design_guidance",
				arguments: { query: GOLDEN, system: "garden" },
			},
		})) as { result: { isError?: boolean; content?: Array<{ text: string }> } };
		expect(called.result.isError).toBeUndefined();
		expect(JSON.parse(called.result.content?.[0]?.text ?? "")).toEqual({
			results: [
				{
					passage: "Garden combobox keeps keyboard focus in the input while the listbox is open.",
					source: "Garden",
					url: "https://garden.zendesk.com/",
					system: "garden",
					score: 0.84,
				},
			],
		});
	});

	it("treats a missing parks key as an empty map", async () => {
		const kv = parksKvGetRaw(memoryKV(), null);
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		expect(await readParks(env)).toEqual({ kind: "ok", parks: {} });
	});

	it("treats parks KV get or parse failure as unread, not empty", async () => {
		const thrown = parksKvGetThrows(memoryKV());
		const junk = parksKvGetRaw(memoryKV(), "{not-json");
		expect(await readParks(envWithIndex(fixtureChunks, true, { INDEX: thrown }).env)).toEqual({
			kind: "unread",
		});
		expect(await readParks(envWithIndex(fixtureChunks, true, { INDEX: junk }).env)).toEqual({
			kind: "unread",
		});
	});

	it("does not write parks when the existing map is unread", async () => {
		const kv = parksKvGetThrows(memoryKV());
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1);
		expect(kv.store.get(PARKS_KEY)).toBeUndefined();
	});

	it("returns 503 index_not_ready from search and MCP when parks are unread", async () => {
		const kv = parksKvGetThrows(memoryKV());
		const { env, calls } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		const searched = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: GOLDEN, system: "garden" }),
			}),
			env,
		);
		expect(searched.status).toBe(503);
		expect(await searched.json()).toEqual({ error: "index_not_ready" });
		const listed = await worker.fetch(
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			env,
		);
		expect(listed.status).toBe(503);
		expect(await listed.json()).toEqual({ error: "index_not_ready" });
		expect(calls).toEqual([]);
	});

	it("has no manual unpark HTTP route", async () => {
		const { env } = envWithIndex(fixtureChunks);
		for (const method of ["GET", "POST"] as const) {
			const response = await worker.fetch(new Request("https://example.test/v1/unpark", { method }), env);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "not_found" });
		}
	});
});
