import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchCall, WorkerEnv } from "../src/index/ai-search.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";

function envWithIndex(chunks: typeof fixtureChunks, ready = true): {
	env: WorkerEnv;
	calls: SearchCall[];
} {
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

describe("HTTP search against a fixture index", () => {
	it("returns 400 when query is missing", async () => {
		const { env } = envWithIndex(fixtureChunks);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ k: 4 }),
			}),
			env,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "query_required" });
	});

	it("returns an empty results list when the index matches nothing", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "no-such-passage" }),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ results: [] });
		expect(calls[0].query).toBe("no-such-passage");
		expect(calls[0].ai_search_options.query_rewrite.enabled).toBe(false);
	});

	it("maps fixture chunks to citation JSON and never sends messages", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const response = await worker.fetch(
			new Request(
				"https://example.test/v1/search?query=accessible%20combobox%20listbox%20keyboard%20focus&k=8",
			),
			env,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			results: Array<{ system: string; url: string; passage: string }>;
		};
		expect(body.results).toHaveLength(3);
		expect(new Set(body.results.map((row) => row.system)).size).toBeGreaterThanOrEqual(2);
		expect(body.results.every((row) => row.url.startsWith("https://"))).toBe(true);
		expect(body.results[0].passage).toBe(fixtureChunks[0].text);
		expect(calls[0]).not.toHaveProperty("messages");
		expect(calls[0].ai_search_options.query_rewrite).toEqual({ enabled: false });
	});

	it("returns 503 from /health when no completed items exist", async () => {
		const { env } = envWithIndex(fixtureChunks, false);
		const response = await worker.fetch(new Request("https://example.test/health"), env);
		expect(response.status).toBe(503);
	});

	it("keeps chat completions and messages off the query path", () => {
		const serve = readFileSync("src/serve/search.ts", "utf8");
		const client = readFileSync("src/index/ai-search.ts", "utf8");
		expect(`${serve}\n${client}`).not.toMatch(/chatCompletions|messages/);
	});

	it("returns 503 when search cannot reach a ready index", async () => {
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
		const response = await worker.fetch(
			new Request("https://example.test/v1/search?query=combobox"),
			env,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "index_not_ready" });
	});

	it("returns 200 from /health when the index is ready", async () => {
		const { env } = envWithIndex(fixtureChunks, true);
		const response = await worker.fetch(new Request("https://example.test/health"), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
