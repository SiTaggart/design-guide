import {
	CRAWL_POLL_DEADLINE_MS,
	pollJob,
	snapshotJob,
	type CrawlAuth,
	type CrawlJobSnapshot,
} from "../crawl/browser-run.ts";

export const WORKFLOW_POLL_SLEEP = "2 minutes";
export const WORKFLOW_POLL_SLEEP_MS = 2 * 60 * 1000;
export const WORKFLOW_POLL_MAX = Math.ceil(CRAWL_POLL_DEADLINE_MS / WORKFLOW_POLL_SLEEP_MS);

export type WorkflowSleepStep = {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	sleep(name: string, duration: string | number): Promise<void>;
};

export async function waitForCrawlJob(
	step: WorkflowSleepStep,
	auth: CrawlAuth,
	jobId: string,
	system: string,
	options?: { maxPolls?: number },
): Promise<CrawlJobSnapshot> {
	const maxPolls = options?.maxPolls ?? WORKFLOW_POLL_MAX;
	let n = 0;
	for (;;) {
		const snapshot = await step.do(`poll-${system}-${n}`, async () => {
			return snapshotJob(await pollJob(auth, jobId));
		});
		if (snapshot.status && snapshot.status !== "running") {
			return snapshot;
		}
		n += 1;
		if (n >= maxPolls) {
			throw new Error(`crawl ${jobId} still running at the poll deadline`);
		}
		await step.sleep(`wait-${system}-${n - 1}`, WORKFLOW_POLL_SLEEP);
	}
}
