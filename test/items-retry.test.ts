import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemApiError, deleteItem, uploadItem } from "../src/index/items-rest.ts";

const auth = { accountId: "acct", apiToken: "token", instanceId: "design-guide" };

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("AI Search upload and delete retries", () => {
	it("stores the item after error 7009 responses and records the overload", async () => {
		let calls = 0;
		const overload: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls += 1;
				if (calls < 3) {
					return jsonResponse(500, { errors: [{ code: 7009, message: "Upstream service unavailable" }] });
				}
				return jsonResponse(200, { result: { id: "item-1", key: "primer/gen/a.md" } });
			}),
		);
		const item = await uploadItem(
			auth,
			"primer/gen/a.md",
			"# one",
			{ system: "primer", source: "Primer", source_url: "https://primer.style/" },
			{
				sleep: async () => {},
				onOverload: () => {
					overload.push(7009);
				},
			},
		);
		expect(item).toEqual({ id: "item-1", key: "primer/gen/a.md" });
		expect(calls).toBe(3);
		expect(overload).toEqual([7009, 7009]);
	});

	it("deletes the item after error 7114 responses", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls += 1;
				if (calls === 1) {
					return jsonResponse(500, { errors: [{ code: 7114, message: "overloaded" }] });
				}
				return jsonResponse(200, { success: true });
			}),
		);
		await deleteItem(auth, "item-9", { sleep: async () => {} });
		expect(calls).toBe(2);
	});

	it("resolves a real item id when upload returns 7042", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (new URL(url).searchParams.get("key") === "primer/gen/a.md") {
					return jsonResponse(200, { result: [{ id: "real-1", key: "primer/gen/a.md" }] });
				}
				return jsonResponse(409, { errors: [{ code: 7042, message: "item_key_already_exist" }] });
			}),
		);
		const item = await uploadItem(auth, "primer/gen/a.md", "# one", {
			system: "primer",
			source: "Primer",
			source_url: "https://primer.style/",
		});
		expect(item).toEqual({ id: "real-1", key: "primer/gen/a.md" });
		expect(item.id).not.toBe(item.key);
	});

	it("refuses a 7042 lookup that only has the key string as its id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (new URL(url).searchParams.has("key")) {
					return jsonResponse(200, { result: [{ id: "primer/gen/a.md", key: "primer/gen/a.md" }] });
				}
				return jsonResponse(409, { errors: [{ code: 7042, message: "item_key_already_exist" }] });
			}),
		);
		await expect(
			uploadItem(auth, "primer/gen/a.md", "# one", {
				system: "primer",
				source: "Primer",
				source_url: "https://primer.style/",
			}),
		).rejects.toThrow(/id was not found/);
	});

	it("throws the 7009 payload after the backoff attempts are used", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls += 1;
				return jsonResponse(500, { errors: [{ code: 7009, message: "Upstream service unavailable" }] });
			}),
		);
		const failure = uploadItem(
			auth,
			"primer/gen/a.md",
			"# one",
			{ system: "primer", source: "Primer", source_url: "https://primer.style/" },
			{ sleep: async () => {} },
		);
		await expect(failure).rejects.toBeInstanceOf(ItemApiError);
		await expect(failure).rejects.toMatchObject({ code: 7009, overload: true });
		expect(calls).toBe(5);
	});
});

