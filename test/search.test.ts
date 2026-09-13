import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchCall, WorkerEnv } from "../src/index/ai-search.ts";
import type { SearchChunk } from "../src/config/types.ts";
import worker from "../src/worker.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";

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
				"https://example.test/v1/search?query=accessible%20combobox%20or%20listbox%20keyboard%20and%20focus%20guidance&k=8",
			),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ results: fixtureCitations });
		expect(calls[0]).not.toHaveProperty("messages");
		expect(calls[0].ai_search_options.query_rewrite).toEqual({ enabled: false });
	});

	it("omits a 0.59 hit from citation JSON and keeps a 0.6 hit", async () => {
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
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: "accessible combobox or listbox keyboard and focus guidance",
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
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

	it("drops missing, string, out-of-range, and NaN scores from HTTP results", async () => {
		const metadata = {
			system: "govuk",
			source: "GOV.UK",
			source_url: "https://design-system.service.gov.uk/",
		};
		const extras: SearchChunk[] = [
			{ text: "missing score", item: { metadata } },
			{ text: "string score", score: "0.9", item: { metadata } },
			{ text: "out of range", score: 1.1, item: { metadata } },
			{ text: "nan score", score: Number.NaN, item: { metadata } },
		];
		const { env } = envWithIndex([...fixtureChunks, ...extras]);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: "accessible combobox or listbox keyboard and focus guidance",
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ results: fixtureCitations });
	});

	it("returns an empty results list when every hit scores below 0.6", async () => {
		const low = fixtureChunks.map((chunk) => ({ ...chunk, score: 0.59 }));
		const { env } = envWithIndex(low);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: "accessible combobox or listbox keyboard and focus guidance",
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ results: [] });
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
