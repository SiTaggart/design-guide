import { describe, expect, it } from "vitest";
import { parseSearchFields } from "../src/serve/parse.ts";

describe("parseSearchFields", () => {
	it("rejects a missing query", () => {
		expect(parseSearchFields({})).toEqual({ kind: "query_required" });
		expect(parseSearchFields({ query: "   " })).toEqual({ kind: "query_required" });
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
