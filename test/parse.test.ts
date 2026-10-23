import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS } from "../src/config/instance.ts";
import { parseSearchFields } from "../src/serve/parse.ts";

describe("parseSearchFields", () => {
	it("rejects a missing query", () => {
		expect(parseSearchFields({})).toEqual({ kind: "query_required" });
		expect(parseSearchFields({ query: "   " })).toEqual({ kind: "query_required" });
	});

	it("rejects a query longer than the cap and keeps one at the cap", () => {
		expect(parseSearchFields({ query: "q".repeat(MAX_QUERY_CHARS + 1) })).toEqual({
			kind: "query_too_long",
		});
		expect(parseSearchFields({ query: `  ${"q".repeat(MAX_QUERY_CHARS)}  ` })).toMatchObject({
			kind: "ok",
			params: { query: "q".repeat(MAX_QUERY_CHARS) },
		});
	});

	it("omits k unless the caller sets it, and clamps a set k to 1..50", () => {
		expect(parseSearchFields({ query: "focus" })).toMatchObject({
			kind: "ok",
			params: { query: "focus", k: undefined },
		});
		expect(parseSearchFields({ query: "focus", k: 0 })).toMatchObject({
			params: { k: 1 },
		});
		expect(parseSearchFields({ query: "focus", k: 99 })).toMatchObject({
			params: { k: 50 },
		});
		expect(parseSearchFields({ query: "focus", k: "nope" })).toMatchObject({
			params: { k: undefined },
		});
		expect(parseSearchFields({ query: "focus", k: 4 })).toMatchObject({
			params: { k: 4 },
		});
	});

	it("treats an unknown system as an empty result, not an invented filter", () => {
		expect(parseSearchFields({ query: "focus", system: "bootstrap" })).toEqual({
			kind: "empty",
		});
		expect(parseSearchFields({ query: "focus", system: "react-spectrum" })).toEqual({
			kind: "empty",
		});
		expect(parseSearchFields({ query: "focus", system: "carbon" })).toEqual({
			kind: "empty",
		});
	});
});
