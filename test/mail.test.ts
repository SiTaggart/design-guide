import { describe, expect, it, vi } from "vitest";
import type { SystemId } from "../src/config/types.ts";
import { LAST_INDEXED_HASH_KEY, startStatusRun } from "../src/index/status.ts";
import {
	INDEX_MAIL_FROM,
	INDEX_MAIL_TO,
	INDEX_STATUS_URL,
	MAIL_STEP_RETRIES,
	finishIndexMail,
	sendFinishIndexMail,
	sendIndexMail,
	sendStartIndexMail,
	startIndexMail,
} from "../src/index/mail.ts";
import { readParks, writePark } from "../src/index/parks.ts";
import { ReindexWorkflow } from "../src/workflows/reindex.ts";
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
	trigger: "drift" as const,
	workflowId: "reindex-drift-mail",
	systems: ["primer", "garden"] as SystemId[],
};

describe("index mail", () => {
	it("composes start mail with trigger, systems, and status URL", () => {
		const mail = startIndexMail(params);
		expect(mail.to).toBe(INDEX_MAIL_TO);
		expect(mail.from).toEqual(INDEX_MAIL_FROM);
		expect(mail.subject).toBe("design-guide index started (drift) reindex-drift-mail");
		expect(mail.text).toContain("Trigger: drift");
		expect(mail.text).toContain("Workflow: reindex-drift-mail");
		expect(mail.text).toContain("Systems: primer, garden");
		expect(mail.text).toContain(`Status: ${INDEX_STATUS_URL}`);
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
			await readParks(env),
		);
		expect(mail.subject).toBe("design-guide index finished fail (drift) reindex-drift-mail");
		expect(mail.text).toContain("Systems touched: garden, primer");
		expect(mail.text).toContain("Counts: systems=2 indexed=0 parked=1 errors=1");
		expect(mail.text).toContain("garden: stub usable=1");
		expect(mail.text).toContain("index primer: item upload failed primer/x.md: boom");
		expect(mail.text).toContain("garden indexed=0 usable=1");
		expect(mail.text).toContain("primer indexed=0 usable=0");
		expect(mail.text).toContain(`Status: ${INDEX_STATUS_URL}`);
		expect(mail.text).not.toMatch(/records|markdown/);
	});

	it("sends through env.EMAIL.send and skips when the binding is missing", async () => {
		const email = mockEmail();
		const { env } = envWithIndex(fixtureChunks, true, { EMAIL: email.binding });
		await expect(sendStartIndexMail(env, params)).resolves.toEqual({ messageId: "msg-1" });
		expect(email.sent[0]).toMatchObject({
			to: INDEX_MAIL_TO,
			from: INDEX_MAIL_FROM,
			subject: "design-guide index started (drift) reindex-drift-mail",
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

	it("mails start and finish on an empty-systems run without writing hashes or last-run", async () => {
		const email = mockEmail();
		const kv = memoryKV({ [LAST_INDEXED_HASH_KEY]: "keep-me" });
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			EMAIL: email.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await startStatusRun(env, { trigger: "drift", workflowId: "reindex-drift-live" });
		const { names, configs, step } = recordingStep();
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const results = await workflow.run(
			{
				payload: {
					trigger: "drift",
					systems: [],
					catalogHash: "unused",
					workflowId: "reindex-mail-proof",
				},
				timestamp: new Date("2026-09-27T05:00:00.000Z"),
				instanceId: "reindex-mail-proof",
				workflowName: "design-guide-reindex",
			},
			step as never,
		);
		expect(results).toEqual([]);
		expect(names).toEqual(["ensure-sweep", "mail-start", "finish", "mail-finish"]);
		expect(configs).toEqual([MAIL_STEP_RETRIES, MAIL_STEP_RETRIES]);
		expect(email.sent).toHaveLength(2);
		expect(email.sent[0]?.subject).toContain("index started");
		expect(email.sent[1]?.subject).toContain("index finished ok");
		expect(email.sent[1]?.text).toContain("Systems touched: (none)");
		expect(email.sent[1]?.text).toContain("Counts: systems=0 indexed=0 parked=0 errors=0");
		expect(kv.store.get(LAST_INDEXED_HASH_KEY)).toBe("keep-me");
		expect(JSON.parse(kv.store.get("status") ?? "{}")).toMatchObject({
			workflowId: "reindex-drift-live",
			state: "running",
		});
	});
});
