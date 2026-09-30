import type { WorkerEnv } from "./index/ai-search.ts";
import { fillTick } from "./index/fill.ts";

export async function handleScheduled(
	controller: ScheduledController,
	env: WorkerEnv,
): Promise<void> {
	await fillTick(env, controller.cron);
}
