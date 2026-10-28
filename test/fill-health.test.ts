import { describe, expect, it } from "vitest";
import { fillHealthFrom, handleFillHealth } from "../src/serve/fill-health.ts";
import { UrlQueue } from "../src/index/url-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex } from "./helpers/index-env.ts";

describe("fill health", () => {
	it("reports queue depth and the age of the oldest row", async () => {
		const checkedAt = "2026-10-28T00:05:00.000Z";
		expect(fillHealthFrom(0, null, checkedAt)).toEqual({
			fill: "ok",
			depth: 0,
			oldestAgeMs: null,
			checkedAt,
		});
		const db = memoryD1();
		const queue = new UrlQueue(db);
		await queue.enqueue(
			[{ url: "https://primer.style/", systemId: "primer", op: "fetch" }],
			{ ms: Date.parse("2026-10-28T00:00:00.000Z") },
		);
		const { env } = envWithIndex([], true, { PAGE_QUEUE: db });
		const response = await handleFillHealth(env);
		const body = (await response.json()) as { fill: string; depth: number; oldestAgeMs: number };
		expect(response.status).toBe(200);
		expect(body.fill).toBe("ok");
		expect(body.depth).toBe(1);
		expect(body.oldestAgeMs).toBeGreaterThan(0);
	});
});
