import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchCall, WorkerEnv } from "../src/index/ai-search.ts";
import type { SearchChunk } from "../src/config/types.ts";
import worker from "../src/worker.ts";
import { fixtureChunks, withVectorScore } from "./fixtures/chunks.ts";
import { MAX_QUERY_CHARS, RETRIEVAL_CANDIDATES, MIN_SEARCH_SCORE } from "../src/config/instance.ts";

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
	it("returns 400 when the query is longer than the cap and does not search", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const overLong = "q".repeat(MAX_QUERY_CHARS + 1);
		const posted = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: overLong }),
			}),
			env,
		);
		expect(posted.status).toBe(400);
		expect(await posted.json()).toEqual({ error: "query_too_long" });
		const gotten = await worker.fetch(
			new Request(`https://example.test/v1/search?query=${overLong}`),
			env,
		);
		expect(gotten.status).toBe(400);
		expect(await gotten.json()).toEqual({ error: "query_too_long" });
		expect(calls).toEqual([]);
	});

	it("accepts a query of the cap in code points and rejects one more", async () => {
		const { env, calls } = envWithIndex(fixtureChunks);
		const atCap = "😀".repeat(MAX_QUERY_CHARS);
		const posted = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: atCap }),
			}),
			env,
		);
		expect(posted.status).toBe(200);
		expect(calls.map((call) => call.query)).toEqual([atCap]);
		const rejected = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: `${atCap}😀` }),
			}),
			env,
		);
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toEqual({ error: "query_too_long" });
		expect(calls.map((call) => call.query)).toEqual([atCap]);
	});

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
		expect(calls[0].ai_search_options.reranking).toEqual({ enabled: false });
		expect(calls[0].ai_search_options.retrieval).toEqual({
			max_num_results: RETRIEVAL_CANDIDATES,
			retrieval_type: "vector",
		});
	});

	it("omits a 0.59 hit from citation JSON and keeps a 0.6 hit", async () => {
		const extra: SearchChunk[] = [
			withVectorScore(
				{
					text: "just below",
					score: 1,
					item: {
						metadata: {
							system: "govuk",
							source: "GOV.UK",
							source_url: "https://design-system.service.gov.uk/",
						},
					},
				},
				0.59,
			),
			withVectorScore(
				{
					text: "boundary keep",
					score: 1,
					item: {
						metadata: {
							system: "nhs",
							source: "NHS",
							source_url: "https://service-manual.nhs.uk/",
						},
					},
				},
				0.6,
			),
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
			{ text: "missing score", score: 1, item: { metadata } },
			{ text: "string score", score: 1, scoring_details: { vector_score: "0.9" }, item: { metadata } },
			{ text: "out of range", score: 0.9, scoring_details: { vector_score: 1.1 }, item: { metadata } },
			{ text: "nan score", score: 0.9, scoring_details: { vector_score: Number.NaN }, item: { metadata } },
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

	it("omits a hit under 0.6 and keeps a hit at or above it", async () => {
		const chunks: SearchChunk[] = [
			withVectorScore(
				{
					text: "Buttons show the actions available on a page.",
					score: 1,
					item: {
						metadata: {
							system: "paste",
							source: "Paste",
							source_url: "https://paste-dsys.com/components/button",
						},
					},
				},
				0.458,
			),
			withVectorScore(
				{
					text: "The wizard includes a Button.",
					score: 1,
					item: {
						metadata: {
							system: "paste",
							source: "Paste",
							source_url: "https://paste-dsys.com/page-templates/wizard",
						},
					},
				},
				0.833,
			),
		];
		const { env } = envWithIndex(chunks);
		const response = await worker.fetch(
			new Request("https://example.test/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "Paste buttons guidance" }),
			}),
			env,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { results: { url: string; score: number }[] };
		expect(body.results.map((hit) => ({ url: hit.url, score: hit.score }))).toEqual([
			{ url: "https://paste-dsys.com/page-templates/wizard", score: 0.833 },
		]);
		expect(body.results.every((hit) => hit.score >= MIN_SEARCH_SCORE)).toBe(true);
	});

	it("returns an empty results list when every hit scores below 0.6", async () => {
		const low = fixtureChunks.map((chunk) => withVectorScore({ ...chunk, score: 1 }, 0.59));
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
