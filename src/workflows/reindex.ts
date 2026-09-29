import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { INSTANCE_ID } from "../config/instance.ts";
import { seedById } from "../config/seed.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import { cancelCrawl, crawlStatusCounts, fetchCrawlPage, startSeedCrawl } from "../crawl/browser-run.ts";
import { ensureInstance } from "../index/items-rest.ts";
import {
	deleteDroppedSystemItems,
	reindexFailure,
	streamSwap,
	swapGeneration,
	type ReindexAuth,
	type SystemReindexResult,
} from "../index/reindex.ts";
import { MAIL_STEP_RETRIES, sendFinishIndexMail, sendStartIndexMail } from "../index/mail.ts";
import { finishStatusRun, startStatusRun, type ReindexParams } from "../index/status.ts";
import { readParks } from "../index/parks.ts";
import { commitIndexedHashes, driftBatch, persistSystemOutcome, reindexAuth } from "../index/trigger.ts";
import { waitForCrawlJob } from "../index/workflow-poll.ts";

const OVERLOAD_SYSTEM_GAP = "30 seconds";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runStep<T extends Rpc.Serializable<T>>(
	step: WorkflowStep,
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	return step.do(name, () => run());
}

export class ReindexWorkflow extends WorkflowEntrypoint<WorkerEnv, ReindexParams> {
	async run(event: WorkflowEvent<ReindexParams>, step: WorkflowStep): Promise<SystemReindexResult[]> {
		const params = event.payload;
		const env = this.env;
		const auth = reindexAuth(env);
		if (!auth) {
			return [];
		}

		const results: SystemReindexResult[] = [];
		let runError: string | undefined;
		try {
			await step.do("ensure-sweep", async () => {
				const itemsAuth = { ...auth, instanceId: INSTANCE_ID };
				await ensureInstance(itemsAuth);
				const dropped = await deleteDroppedSystemItems(itemsAuth);
				await startStatusRun(env, { trigger: params.trigger, workflowId: params.workflowId });
				return { dropped };
			});

			const batch =
				params.trigger === "deploy-drift"
					? await step.do("drift-batch", async () => driftBatch(params.systems, await readParks(env)))
					: params.systems;

			try {
				await step.do("mail-start", MAIL_STEP_RETRIES, async () => {
					return sendStartIndexMail(env, { ...params, systems: batch });
				});
			} catch (error) {
				console.log(
					JSON.stringify({ event: "index_mail_failed", phase: "start", error: errorMessage(error) }),
				);
			}

			for (const [index, system] of batch.entries()) {
				const overload = { seen: false };
				try {
					results.push(await this.indexSystem(step, env, auth, system, params.workflowId, overload));
				} catch (error) {
					const failed = reindexFailure(seedById(system), errorMessage(error));
					await persistSystemOutcome(env, failed);
					results.push(failed);
				}
				if (overload.seen && index < batch.length - 1) {
					await step.sleep(`cool-${system}`, OVERLOAD_SYSTEM_GAP);
				}
			}
		} catch (error) {
			runError = errorMessage(error);
		}

		await step.do("finish", async () => {
			if (params.systems.length > 0) {
				if (!runError) {
					await commitIndexedHashes(env);
				}
				await finishStatusRun(env, results, undefined, params.workflowId, runError);
			}
			return { systems: results.length, failed: Boolean(runError) };
		});

		try {
			await step.do("mail-finish", MAIL_STEP_RETRIES, async () => {
				return sendFinishIndexMail(env, params, results, runError);
			});
		} catch (error) {
			console.log(
				JSON.stringify({ event: "index_mail_failed", phase: "finish", error: errorMessage(error) }),
			);
		}
		return results;
	}

	private async indexSystem(
		step: WorkflowStep,
		env: WorkerEnv,
		auth: ReindexAuth,
		system: ReindexParams["systems"][number],
		workflowId: string,
		overload: { seen: boolean },
	): Promise<SystemReindexResult> {
		const seed = seedById(system);
		const generation = swapGeneration(system, workflowId);
		try {
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

			try {
				const snapshot = await waitForCrawlJob(step, auth, started.jobId, system);
				const result = await streamSwap(auth, seed, {
					startUrl: started.startUrl,
					snapshot,
					generation,
					fetchPage: (cursor) => fetchCrawlPage(auth, started.jobId, "completed", cursor),
					countStatuses: () => crawlStatusCounts(snapshot),
					step: (name, run) => runStep(step, name, run),
					onOverload: () => {
						overload.seen = true;
					},
				});
				await step.do(`record-${system}`, async () => {
					await persistSystemOutcome(env, result);
					return result;
				});
				return result;
			} catch (error) {
				try {
					await step.do(`cancel-${system}`, async () => {
						await cancelCrawl(auth, started.jobId);
						return { cancelled: true };
					});
				} catch (cancelError) {
					console.log(
						JSON.stringify({
							event: "crawl_cancel_failed",
							system,
							error: errorMessage(cancelError),
						}),
					);
				}
				const failed = reindexFailure(seed, errorMessage(error));
				await step.do(`record-failed-${system}`, async () => {
					await persistSystemOutcome(env, failed);
					return failed;
				});
				return failed;
			}
		} catch (error) {
			const failed = reindexFailure(seed, errorMessage(error));
			await step.do(`record-failed-${system}`, async () => {
				await persistSystemOutcome(env, failed);
				return failed;
			});
			return failed;
		}
	}
}
