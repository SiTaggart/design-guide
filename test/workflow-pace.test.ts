import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { writePark } from "../src/index/parks.ts";
import { ReindexWorkflow } from "../src/workflows/reindex.ts";
import { fixtureChunks } from "./fixtures/chunks.ts";
import { envWithIndex, memoryKV, parksKvGetThrows } from "./helpers/index-env.ts";

const streamSwap = vi.hoisted(() => vi.fn());
const startSeedCrawl = vi.hoisted(() => vi.fn());
const pollJob = vi.hoisted(() => vi.fn());

vi.mock("../src/index/reindex.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/index/reindex.ts")>();
	return { ...actual, streamSwap };
});

vi.mock("../src/crawl/browser-run.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/crawl/browser-run.ts")>();
	return { ...actual, startSeedCrawl, pollJob };
});

vi.mock("../src/index/items-rest.ts", () => ({
	ensureInstance: vi.fn(async () => undefined),
	listItems: vi.fn(async () => []),
	deleteItem: vi.fn(async () => undefined),
	uploadItem: vi.fn(async () => ({ id: "1", key: "k" })),
}));

function stepContext(name: string): WorkflowStepContext {
	return {
		step: { name, count: 1 },
		attempt: 1,
		config: {},
	};
}

function stepRecorder(): { sleeps: Array<string | number>; step: WorkflowStep } {
	const sleeps: Array<string | number> = [];
	const step: WorkflowStep = {
		do(name, configOrCallback, maybeCallback) {
			const run = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
			if (typeof run !== "function") {
				return Promise.reject(new Error(`missing callback for ${name}`));
			}
			return run(stepContext(name));
		},
		sleep(_name, duration) {
			sleeps.push(duration);
			return Promise.resolve();
		},
		sleepUntil() {
			return Promise.resolve();
		},
		waitForEvent() {
			return Promise.reject(new Error("waitForEvent is unused"));
		},
	};
	return { sleeps, step };
}

describe("reindex workflow overload gap", () => {
	it("sleeps 30 seconds between systems after an AI Search overload and not after the last system", async () => {
		startSeedCrawl.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
			startUrl: seed.startUrl,
			jobId: "job-1",
		}));
		pollJob.mockResolvedValue({ status: "completed", total: 2, finished: 2 });
		streamSwap.mockImplementation(async (_auth: unknown, seed: { id: string; startUrl: string }, input: { onOverload?: () => void }) => {
			input.onOverload?.();
			return {
				system: seed.id,
				startUrl: seed.startUrl,
				crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
				indexed: 2,
				hitLimit: false,
				keptPrevious: false,
				usable: 2,
			};
		});
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { sleeps, step } = stepRecorder();
		await workflow.run(
			{
				payload: {
					trigger: "recrawl",
					systems: ["paste", "primer"],
					catalogHash: "hash",
					workflowId: "reindex-recrawl-pace",
				},
				timestamp: new Date("2026-09-27T00:00:00.000Z"),
				instanceId: "reindex-recrawl-pace",
				workflowName: "reindex",
			},
			step,
		);
		expect(sleeps).toEqual(["30 seconds"]);
		expect(streamSwap).toHaveBeenCalledTimes(2);
	});
});

const INCIDENT_SYSTEMS = SYSTEM_IDS.slice(0, 11);

function sentMail(): {
	sent: Array<{ subject?: string; text?: string }>;
	binding: SendEmail;
} {
	const sent: Array<{ subject?: string; text?: string }> = [];
	return {
		sent,
		binding: {
			send: async (message: EmailMessage | EmailMessageBuilder) => {
				sent.push(message as { subject?: string; text?: string });
				return { messageId: `msg-${sent.length}` };
			},
		},
	};
}

function payload(systems: readonly (typeof SYSTEM_IDS)[number][], workflowId: string) {
	return {
		payload: {
			trigger: "deploy-drift" as const,
			systems: [...systems],
			catalogHash: "hash",
			workflowId,
		},
		timestamp: new Date("2026-09-29T00:00:00.000Z"),
		instanceId: workflowId,
		workflowName: "reindex",
	};
}

describe("deploy-drift one system", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("mails and runs one system when the payload lists the 11-system incident", async () => {
		startSeedCrawl.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
			startUrl: seed.startUrl,
			jobId: "job-1",
		}));
		pollJob.mockResolvedValue({ status: "completed", total: 2, finished: 2 });
		streamSwap.mockImplementation(async (_auth: unknown, seed: { id: string; startUrl: string }) => ({
			system: seed.id,
			startUrl: seed.startUrl,
			crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 2,
			hitLimit: false,
			keptPrevious: false,
			usable: 2,
		}));
		const email = sentMail();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			EMAIL: email.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { step } = stepRecorder();
		const results = await workflow.run(payload(INCIDENT_SYSTEMS, "reindex-deploy-drift-incident"), step);
		expect(results.map((result) => result.system)).toEqual(["paste"]);
		expect(streamSwap).toHaveBeenCalledTimes(1);
		expect(email.sent[0]?.text).toContain("Systems: paste");
		expect(email.sent[0]?.text).not.toContain("primer");
		expect(email.sent[1]?.text).toContain("Counts: systems=1 indexed=2");
	});

	it("skips parked seeds in an 11-system deploy-drift payload", async () => {
		startSeedCrawl.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
			startUrl: seed.startUrl,
			jobId: "job-1",
		}));
		pollJob.mockResolvedValue({ status: "completed", total: 2, finished: 2 });
		streamSwap.mockImplementation(async (_auth: unknown, seed: { id: string; startUrl: string }) => ({
			system: seed.id,
			startUrl: seed.startUrl,
			crawl: { total: 2, finished: 2, skipped: 0, disallowed: 0, errored: 0 },
			indexed: 2,
			hitLimit: false,
			keptPrevious: false,
			usable: 2,
		}));
		const email = sentMail();
		const kv = memoryKV();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: kv,
			EMAIL: email.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		await writePark(env, "paste", 1);
		await writePark(env, "primer", 1);
		await writePark(env, "uswds", 1);
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { step } = stepRecorder();
		const results = await workflow.run(payload(INCIDENT_SYSTEMS, "reindex-deploy-drift-parked"), step);
		expect(results.map((result) => result.system)).toEqual(["govuk"]);
		expect(email.sent[0]?.text).toContain("Systems: govuk");
		expect(email.sent[0]?.text).not.toContain("paste");
	});

	it("runs no deploy-drift system when parks cannot be read", async () => {
		streamSwap.mockImplementation(async () => {
			throw new Error("streamSwap should not run");
		});
		const email = sentMail();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: parksKvGetThrows(memoryKV()),
			EMAIL: email.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { step } = stepRecorder();
		const results = await workflow.run(payload(["paste", "primer"], "reindex-deploy-drift-unread"), step);
		expect(results).toEqual([]);
		expect(streamSwap).not.toHaveBeenCalled();
		expect(email.sent[0]?.text).toContain("Systems: (none)");
		expect(email.sent[1]?.text).toContain("Counts: systems=0 indexed=0");
	});

	it("keeps the previous generation and cancels the crawl when a step dies", async () => {
		startSeedCrawl.mockImplementation(async (_auth: unknown, seed: { startUrl: string }) => ({
			startUrl: seed.startUrl,
			jobId: "job-oom",
		}));
		pollJob.mockRejectedValue(new Error("Worker exceeded memory limit"));
		const deleted: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === "DELETE") {
					deleted.push(url);
				}
				return Response.json({ success: true, result: {} });
			}),
		);
		const email = sentMail();
		const { env } = envWithIndex(fixtureChunks, true, {
			INDEX: memoryKV(),
			EMAIL: email.binding,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		const workflow = new ReindexWorkflow({} as ExecutionContext, env);
		const { step } = stepRecorder();
		const results = await workflow.run(payload(["primer", "patternfly"], "reindex-deploy-drift-oom"), step);
		expect(results).toEqual([
			expect.objectContaining({
				system: "primer",
				indexed: 0,
				keptPrevious: true,
				hitLimit: false,
				error: "Worker exceeded memory limit",
			}),
		]);
		expect(streamSwap).not.toHaveBeenCalled();
		expect(deleted).toEqual([
			"https://api.cloudflare.com/client/v4/accounts/acct/browser-rendering/crawl/job-oom",
		]);
		expect(email.sent[0]?.text).toContain("Systems: primer");
		expect(email.sent[1]?.text).toContain("hitLimit=false");
		expect(email.sent[1]?.text).toContain("Counts: systems=1 indexed=0");
	});
});
