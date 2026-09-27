import {
	pollJob,
	snapshotJob,
	type CrawlAuth,
	type CrawlJobSnapshot,
} from "../crawl/browser-run.ts";

export const WORKFLOW_POLL_SLEEP = "2 minutes";

export type WorkflowSleepStep = {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	sleep(name: string, duration: string | number): Promise<void>;
};

export async function waitForCrawlJob(
	step: WorkflowSleepStep,
	auth: CrawlAuth,
	jobId: string,
	system: string,
): Promise<CrawlJobSnapshot> {
	let n = 0;
	for (;;) {
		const snapshot = await step.do(`poll-${system}-${n}`, async () => {
			return snapshotJob(await pollJob(auth, jobId));
		});
		if (snapshot.status && snapshot.status !== "running") {
			return snapshot;
		}
		await step.sleep(`wait-${system}-${n}`, WORKFLOW_POLL_SLEEP);
		n += 1;
	}
}
