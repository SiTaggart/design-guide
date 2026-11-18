import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wrangler automation config", () => {
	const wrangler = readFileSync("wrangler.jsonc", "utf8");

	it("uses Worker crons and a 25000-step Workflow, not Workflow schedules", () => {
		expect(wrangler).toContain('"*/5 * * * *"');
		expect(wrangler).toContain('"0 4 * * *"');
		expect(wrangler).toContain('"0 6 * * SUN"');
		expect(wrangler).not.toContain("ReindexWorkflow");
		expect(wrangler).toContain('"binding": "PAGE_QUEUE"');
		expect(wrangler).not.toContain('"schedules"');
		expect(wrangler).not.toContain("send_email");
	});
});

