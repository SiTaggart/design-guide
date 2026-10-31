import type { WorkerEnv } from "./index/ai-search.ts";
import { conveyorTick } from "./index/conveyor.ts";

export async function handleScheduled(
	controller: ScheduledController,
	env: WorkerEnv,
): Promise<void> {
	await conveyorTick(env, controller.cron);
}
