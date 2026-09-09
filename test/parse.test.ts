import { describe, expect, it } from "vitest";
import { parseSearchFields } from "../src/serve/parse.ts";

describe("parseSearchFields", () => {
	it("rejects a missing query", () => {
		expect(parseSearchFields({})).toEqual({ kind: "query_required" });
		expect(parseSearchFields({ query: "   " })).toEqual({ kind: "query_required" });
	});

	it("defaults and clamps k", () => {
		expect(parseSearchFields({ query: "focus" })).toMatchObject({
			kind: "ok",
			params: { query: "focus", k: 8 },
		});
		expect(parseSearchFields({ query: "focus", k: 0 })).toMatchObject({
			params: { k: 1 },
		});
		expect(parseSearchFields({ query: "focus", k: 99 })).toMatchObject({
			params: { k: 20 },
		});
		expect(parseSearchFields({ query: "focus", k: "nope" })).toMatchObject({
			params: { k: 8 },
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
