import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { collectOutcome, pollJob, startSeedCrawl } from "../crawl/browser-run.ts";
import { ensureInstance } from "../index/items-rest.ts";
import {
	deleteDroppedSystemItems,
	reindexFailure,
	swapFromOutcome,
	type ReindexAuth,
	type SystemReindexResult,
} from "../index/reindex.ts";
import { MAIL_STEP_RETRIES, sendFinishIndexMail, sendStartIndexMail } from "../index/mail.ts";
import { finishStatusRun, startStatusRun, type ReindexParams } from "../index/status.ts";
import { commitIndexedHashes, persistSystemOutcome, reindexAuth } from "../index/trigger.ts";
import { waitForCrawlJob } from "../index/workflow-poll.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ReindexWorkflow extends WorkflowEntrypoint<WorkerEnv, ReindexParams> {
	async run(event: WorkflowEvent<ReindexParams>, step: WorkflowStep): Promise<SystemReindexResult[]> {
		const params = event.payload;
		const env = this.env;
		const auth = reindexAuth(env);
		if (!auth) {
			return [];
		}

		await step.do("ensure-sweep", async () => {
			const itemsAuth = { ...auth, instanceId: INSTANCE_ID };
			await ensureInstance(itemsAuth);
			const dropped = await deleteDroppedSystemItems(itemsAuth);
			await startStatusRun(env, { trigger: params.trigger, workflowId: params.workflowId });
			return { dropped };
		});

		await step.do("mail-start", MAIL_STEP_RETRIES, async () => {
			return sendStartIndexMail(env, params);
		});

		const results: SystemReindexResult[] = [];
		for (const system of params.systems) {
			results.push(await this.indexSystem(step, env, auth, system));
		}

		await step.do("finish", async () => {
			if (params.systems.length > 0) {
				await commitIndexedHashes(env);
				await finishStatusRun(env, results, undefined, params.workflowId);
			}
			return { systems: results.length };
		});

		await step.do("mail-finish", MAIL_STEP_RETRIES, async () => {
			return sendFinishIndexMail(env, params, results);
		});
		return results;
	}

	private async indexSystem(
		step: WorkflowStep,
		env: WorkerEnv,
		auth: ReindexAuth,
		system: ReindexParams["systems"][number],
	): Promise<SystemReindexResult> {
		const seed = seedById(system);
		const started = await step.do(`start-${system}`, async () => {
			try {
				return await startSeedCrawl(auth, seed);
			} catch (error) {
				return { error: errorMessage(error) };
			}
		});
		if ("error" in started) {
			const failed = reindexFailure(seed, started.error);
			await step.do(`record-${system}`, async () => {
				await persistSystemOutcome(env, failed);
				return failed;
			});
			return failed;
		}

		await waitForCrawlJob(step, auth, started.jobId, system);

		return step.do(`apply-${system}`, async () => {
			const job = await pollJob(auth, started.jobId);
			const outcome = await collectOutcome(auth, started.jobId, started.startUrl, job);
			const result = await swapFromOutcome(auth, seed, outcome);
			await persistSystemOutcome(env, result);
			return result;
		});
	}
}
