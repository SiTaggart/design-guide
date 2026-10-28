import { describe, expect, it, vi } from "vitest";
import type { SystemId } from "../src/config/types.ts";
import {
	INDEX_MAIL_FROM,
	INDEX_MAIL_TO,
	INDEX_STATUS_URL,
	finishIndexMail,
	sendFinishIndexMail,
	sendIndexMail,
	sendStartIndexMail,
	startIndexMail,
} from "../src/index/mail.ts";
import { writePark } from "../src/index/parks.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

vi.mock("../src/index/items-rest.ts", () => ({
	uploadItem: vi.fn(),
	deleteItem: vi.fn(),
	listItems: vi.fn(async () => []),
	ensureInstance: vi.fn(),
}));

function mockEmail(): { sent: EmailMessageBuilder[]; binding: SendEmail } {
	const sent: EmailMessageBuilder[] = [];
	return {
		sent,
		binding: {
			send: async (message: EmailMessage | EmailMessageBuilder) => {
				sent.push(message as EmailMessageBuilder);
				return { messageId: `msg-${sent.length}` };
			},
		},
	};
}

function recordingStep(): {
	names: string[];
	configs: unknown[];
	step: {
		do<T>(name: string, configOrCb: unknown, maybeCb?: unknown): Promise<T>;
		sleep(): Promise<void>;
	};
} {
	const names: string[] = [];
	const configs: unknown[] = [];
	return {
		names,
		configs,
		step: {
			async do<T>(name: string, configOrCb: unknown, maybeCb?: unknown): Promise<T> {
				names.push(name);
				const callback = (typeof configOrCb === "function" ? configOrCb : maybeCb) as () => Promise<T>;
				if (typeof configOrCb !== "function") {
					configs.push(configOrCb);
				}
				return callback();
			},
			async sleep() {},
		},
	};
}

const params = {
	trigger: "deploy-drift" as const,
	workflowId: "reindex-deploy-drift-mail",
	systems: ["primer", "garden"] as SystemId[],
};

describe("index mail", () => {
	it("composes start mail with trigger, systems, and status URL", () => {
		const mail = startIndexMail(params);
		expect(INDEX_MAIL_TO).toBe("simon.taggart@gmail.com");
		expect(mail.to).toBe("simon.taggart@gmail.com");
		expect(mail.from).toEqual(INDEX_MAIL_FROM);
		expect(mail.subject).toBe("design-guide index started (deploy-drift) reindex-deploy-drift-mail");
		expect(mail.text).toContain("Trigger: deploy-drift");
		expect(mail.text).toContain("Workflow: reindex-deploy-drift-mail");
		expect(mail.text).toContain("Systems: primer, garden");
		expect(mail.text).toContain(`Status: ${INDEX_STATUS_URL}`);
	});

	it("points mail at /status and does not link an unauthenticated index-status URL", () => {
		expect(INDEX_STATUS_URL).toBe("https://design-guide.me-2c5.workers.dev/status");
		for (const mail of [startIndexMail(params), finishIndexMail(params, [], {})]) {
			expect(mail.text).toContain(`Status: ${INDEX_STATUS_URL}`);
			expect(mail.text).not.toContain("/v1/index-status");
			expect(mail.text).toContain("Authorization: Bearer");
			expect(mail.text).toContain("?token=");
			expect(mail.text).toContain("does not include the secret");
			expect(mail.text).not.toMatch(/[?&]token=\S+/);
		}
	});

	it("composes finish mail with systems, counts, parks, errors, and status URL", async () => {
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv });
		await writePark(env, "garden", 1, "2026-09-27T00:00:00.000Z");
		const mail = finishIndexMail(
			params,
			[
				{
					system: "garden",
					startUrl: "https://garden.zendesk.com/",
					crawl: { total: 1, finished: 1, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					parked: true,
					usable: 1,
					error: "stub: only 1 usable page(s)",
				},
				{
					system: "primer",
					startUrl: "https://primer.style/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					usable: 0,
					error: "item upload failed primer/x.md: boom",
				},
			],
			{ garden: { reason: "stub", usable: 1, at: "2026-09-27T00:00:00.000Z" } },
		);
		expect(mail.subject).toBe("design-guide index finished fail (deploy-drift) reindex-deploy-drift-mail");
		expect(mail.text).toContain("Systems touched: garden, primer");
		expect(mail.text).toContain("Counts: systems=2 indexed=0 parked=1 errors=1");
		expect(mail.text).toContain("garden: stub usable=1");
		expect(mail.text).toContain("index primer: item upload failed primer/x.md: boom");
		expect(mail.text).toContain("garden indexed=0 usable=1");
		expect(mail.text).toContain("primer indexed=0 usable=0");
		expect(mail.text).toContain(`Status: ${INDEX_STATUS_URL}`);
		expect(mail.text).not.toMatch(/records|markdown/);
		expect(mail.text).not.toContain("Unparked:");
	});

	it("lists unparked ids on finish mail only when a park cleared", async () => {
		const mail = finishIndexMail(
			{ trigger: "recovery", workflowId: "reindex-recovery-mail" },
			[
				{
					system: "garden",
					startUrl: "https://garden.zendesk.com/",
					crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 2,
					hitLimit: false,
					keptPrevious: false,
					usable: 2,
				},
			],
			{},
			undefined,
			["garden"],
		);
		expect(mail.to).toBe("simon.taggart@gmail.com");
		expect(mail.from).toBe("design-guide@simontaggart.com");
		expect(mail.subject).toBe("design-guide index finished ok (recovery) reindex-recovery-mail");
		expect(mail.text).toContain("Trigger: recovery");
		expect(mail.text).toContain("Unparked: garden");
		expect(mail.text).toContain("Parks:\n  (none)");
		const omitted = finishIndexMail(
			{ trigger: "recovery", workflowId: "reindex-recovery-mail" },
			[],
			{},
		);
		expect(omitted.to).toBe("simon.taggart@gmail.com");
		expect(omitted.from).toBe("design-guide@simontaggart.com");
		expect(omitted.text).not.toContain("Unparked:");
	});

	it("sends through env.EMAIL.send and skips when the binding is missing", async () => {
		const email = mockEmail();
		const { env } = envWithIndex(fixtureChunks, true, { EMAIL: email.binding });
		await expect(sendStartIndexMail(env, params)).resolves.toEqual({ messageId: "msg-1" });
		expect(email.sent[0]).toEqual({
			from: INDEX_MAIL_FROM,
			to: INDEX_MAIL_TO,
			subject: "design-guide index started (deploy-drift) reindex-deploy-drift-mail",
			text: expect.stringContaining("Trigger: deploy-drift"),
		});
		const { env: unbound } = envWithIndex(fixtureChunks);
		await expect(sendIndexMail(unbound, startIndexMail(params))).resolves.toEqual({ skipped: "unbound" });
		expect(email.sent).toHaveLength(1);
	});

	it("reads parks from KV when sending finish mail", async () => {
		const email = mockEmail();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, { INDEX: kv, EMAIL: email.binding });
		await writePark(env, "garden", 0, "2026-09-27T00:00:00.000Z");
		await expect(
			sendFinishIndexMail(env, params, [
				{
					system: "garden",
					startUrl: "https://garden.zendesk.com/",
					crawl: { total: 0, finished: 0, skipped: 0, disallowed: 0, errored: 0 },
					indexed: 0,
					hitLimit: false,
					keptPrevious: true,
					parked: true,
					usable: 0,
					error: "stub: only 0 usable page(s)",
				},
			]),
		).resolves.toEqual({ messageId: "msg-1" });
		expect(email.sent[0]?.text).toContain("garden: stub usable=0");
		expect(email.sent[0]?.text).toContain("Errors:\n  (none)");
	});
});
