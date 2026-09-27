import type { WorkerEnv } from "./index/ai-search.ts";
import { decideReindex, startReindex } from "./index/trigger.ts";

export async function handleScheduled(
	controller: ScheduledController,
	env: WorkerEnv,
): Promise<void> {
	const decision = await decideReindex(env, controller.cron);
	if (decision.action === "skip") {
		console.log(JSON.stringify({ event: "index_cron_skip", cron: controller.cron, reason: decision.reason }));
		return;
	}
	const started = await startReindex(env, decision);
	if ("skipped" in started) {
		console.log(
			JSON.stringify({ event: "index_cron_skip", cron: controller.cron, reason: started.skipped }),
		);
		return;
	}
	console.log(
		JSON.stringify({
			event: "index_cron_start",
			cron: controller.cron,
			trigger: decision.trigger,
			systems: decision.systems,
			workflowId: started.workflowId,
		}),
	);
}
