import type { WorkerEnv } from "../index/ai-search.ts";
import { oldestAgeMs } from "../index/conveyor.ts";
import { UrlQueue } from "../index/url-queue.ts";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

export type FillHealthBody = {
	fill: "ok";
	depth: number;
	oldestAgeMs: number | null;
	checkedAt: string;
};

export function fillHealthFrom(depth: number, oldestAgeMs: number | null, checkedAt: string): FillHealthBody {
	return { fill: "ok", depth, oldestAgeMs, checkedAt };
}

export async function handleFillHealth(env: WorkerEnv): Promise<Response> {
	const checkedAt = new Date().toISOString();
	if (!env.PAGE_QUEUE) {
		return json(fillHealthFrom(0, null, checkedAt));
	}
	const queue = new UrlQueue(env.PAGE_QUEUE);
	const depth = await queue.depth();
	const oldest = await queue.oldest();
	return json(fillHealthFrom(depth, oldestAgeMs(oldest?.enqueuedAt ?? null, Date.parse(checkedAt)), checkedAt));
}

function json(body: FillHealthBody): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}
