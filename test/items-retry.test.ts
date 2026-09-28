import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { ItemApiError, deleteItem, uploadItem } from "../src/index/items-rest.ts";
import { streamSwap, swapGeneration } from "../src/index/reindex.ts";

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

describe("stream last-wins after a 7042 upload", () => {
	it("deletes the real item id and keeps the later markdown", async () => {
		const generation = swapGeneration("primer", "reindex-7042-id");
		const pageUrl = "https://primer.style/";
		const digest = createHash("sha256").update(pageUrl).digest("hex").slice(0, 16);
		const key = `primer/${generation}/${digest}.md`;
		const items: Array<{ id: string; key: string; body: string }> = [
			{ id: "real-a", key, body: "# stale" },
		];
		const deleted: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = new URL(typeof input === "string" ? input : input.toString());
				const method = init?.method ?? "GET";
				if (method === "DELETE") {
					const marker = "/items/";
					const id = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf(marker) + marker.length));
					deleted.push(id);
					const index = items.findIndex((item) => item.id === id);
					if (index < 0) {
						return jsonResponse(404, { errors: [{ code: 7041, message: "item_not_found" }] });
					}
					items.splice(index, 1);
					return jsonResponse(200, { success: true });
				}
				if (method === "POST") {
					const form = init?.body as FormData;
					const file = form.get("file") as File;
					const itemKey = file.name;
					const body = await file.text();
					const existing = items.find((item) => item.key === itemKey);
					if (existing) {
						return jsonResponse(409, { errors: [{ code: 7042, message: "item_key_already_exist" }] });
					}
					const created = { id: `real-${items.length + 1}`, key: itemKey, body };
					items.push(created);
					return jsonResponse(200, { result: { id: created.id, key: created.key } });
				}
				const lookup = url.searchParams.get("key");
				const result = lookup ? items.filter((item) => item.key === lookup) : items;
				return jsonResponse(200, {
					result: result.map((item) => ({ id: item.id, key: item.key })),
					result_info: { count: result.length, total_count: lookup ? result.length : items.length },
				});
			}),
		);
		const seed = seedById("primer");
		let fetched = 0;
		const result = await streamSwap(
			{ accountId: "acct", apiToken: "token", instanceId: "design-guide" },
			seed,
			{
				startUrl: seed.startUrl,
				snapshot: { status: "completed", total: 2, finished: 2 },
				generation,
				fetchPage: async () => {
					fetched += 1;
					if (fetched === 1) {
						return {
							records: [{ url: pageUrl, status: "completed" as const, markdown: "# stale" }],
							cursor: "2",
						};
					}
					return {
						records: [
							{ url: pageUrl, status: "completed" as const, markdown: "# fresh" },
							{ url: "https://primer.style/select", status: "completed" as const, markdown: "# other" },
						],
						cursor: null,
					};
				},
				countStatuses: async () => ({ total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 }),
			},
		);
		expect(result).toMatchObject({ indexed: 2, keptPrevious: false });
		expect(deleted).toContain("real-a");
		expect(deleted).not.toContain(key);
		expect(items.find((item) => item.key === key)?.body).toBe("# fresh");
		expect(items.find((item) => item.key === key)?.id).not.toBe(key);
	});
});
