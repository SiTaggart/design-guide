import { describe, expect, it } from "vitest";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";

function countingFrontierInserts(db: D1Database): { inserts: () => number } {
	let inserts = 0;
	const prepare = db.prepare.bind(db);
	db.prepare = ((sql: string) => {
		if (sql.includes("INSERT INTO discover_frontier")) {
			inserts += 1;
		}
		return prepare(sql);
	}) as D1Database["prepare"];
	return { inserts: () => inserts };
}

describe("discover frontier writes", () => {
	it("inserts a shared nav once per tick and skips links already collected", async () => {
		const db = memoryD1();
		const counter = countingFrontierInserts(db);
		const pageQueue = new D1PageQueue(db);
		await pageQueue.ensure();
		const nav = Array.from({ length: 40 }, (_value, index) => `https://paste-dsys.com/components/nav-${index}`);
		for (let page = 0; page < 25; page += 1) {
			await pageQueue.addFrontier("paste", [...nav, nav[0] ?? ""]);
		}
		expect(counter.inserts()).toBe(1);
		const again = counter.inserts();
		await pageQueue.addFrontier("paste", nav);
		expect(counter.inserts()).toBe(again);
		expect(await pageQueue.nextFrontier("paste", new Set())).toBe("https://paste-dsys.com/components/nav-0");
	});
});
