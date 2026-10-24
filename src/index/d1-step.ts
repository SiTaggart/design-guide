import { NonRetryableError } from "cloudflare:workflows";

export const D1_STEP_RETRIES = {
	limit: 3,
	delay: "10 seconds",
	backoff: "exponential",
} as const;

export type D1StepRetries = typeof D1_STEP_RETRIES;

export type D1TickBudget = {
	exhausted: boolean;
	error?: unknown;
	/** Set once the tick deadline has refused a write or a retry sleep. */
	deadline: boolean;
	/** Retry sleeps already taken by any statement in this tick. */
	retriesUsed: number;
};

export type D1Tick = {
	retries: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
	budget: D1TickBudget;
	/** Wall time after which this tick starts no D1 write and no retry sleep. */
	deadlineMs?: number;
};

export type D1QueueOptions = {
	retries?: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
	budget?: D1TickBudget;
	deadlineMs?: number;
};

export type D1QueryStep = {
	db: D1Database;
	tick?: D1Tick;
};

export function createD1TickBudget(): D1TickBudget {
	return { exhausted: false, deadline: false, retriesUsed: 0 };
}

export function tickFrom(options?: D1QueueOptions): D1Tick | undefined {
	if (!options?.retries) {
		return undefined;
	}
	return {
		retries: options.retries,
		...(options.sleep ? { sleep: options.sleep } : {}),
		...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
		budget: options.budget ?? createD1TickBudget(),
	};
}

export function isTransientD1Error(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (/object to be reset/i.test(message)) {
		return true;
	}
	return /internal error/i.test(message) && (/d1/i.test(message) || /storage/i.test(message));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function budgetError(budget: D1TickBudget): Error {
	if (budget.error instanceof Error) {
		return budget.error;
	}
	return new NonRetryableError("D1 retry budget exhausted");
}

/**
 * Longest single retry sleep. A sleep starts only while the tick is still before its deadline,
 * so the backoff that can run past the deadline is one sleep, not the whole schedule.
 */
export function d1MaxBackoffMs(retries: D1StepRetries = D1_STEP_RETRIES): number {
	const base = delayMs(retries.delay);
	let max = 0;
	for (let attempt = 0; attempt < retries.limit; attempt += 1) {
		max = Math.max(max, backoffMs(base, attempt, retries.backoff));
	}
	return max;
}

function delayMs(delay: D1StepRetries["delay"]): number {
	const match = /^(\d+)\s+seconds$/.exec(delay);
	if (!match) {
		throw new NonRetryableError(`unsupported D1 retry delay ${delay}`);
	}
	return Number(match[1]) * 1000;
}

function backoffMs(base: number, attempt: number, backoff: D1StepRetries["backoff"]): number {
	if (backoff === "exponential") {
		return base * 2 ** attempt;
	}
	return base;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

class TickDeadlineStop extends Error {
	constructor() {
		super("D1 tick deadline");
		this.name = "TickDeadlineStop";
	}
}

export function pastTickDeadline(tick: D1Tick | undefined): boolean {
	return tick?.deadlineMs !== undefined && Date.now() >= tick.deadlineMs;
}

export function isTickDeadlineStop(error: unknown): boolean {
	return error instanceof TickDeadlineStop;
}

function stopForDeadline(tick: D1Tick): never {
	if (!tick.budget.deadline) {
		tick.budget.deadline = true;
		console.log(JSON.stringify({ event: "d1_tick_deadline", deadlineMs: tick.deadlineMs }));
	}
	throw new TickDeadlineStop();
}

export async function d1Step<T>(name: string, tick: D1Tick, run: () => Promise<T>): Promise<T> {
	if (tick.budget.exhausted) {
		throw budgetError(tick.budget);
	}
	const sleep = tick.sleep ?? defaultSleep;
	const base = delayMs(tick.retries.delay);
	let last: unknown;
	for (;;) {
		if (pastTickDeadline(tick)) {
			stopForDeadline(tick);
		}
		try {
			return await run();
		} catch (error) {
			if (error instanceof TickDeadlineStop) {
				throw error;
			}
			if (error instanceof NonRetryableError || !isTransientD1Error(error)) {
				throw error instanceof NonRetryableError ? error : new NonRetryableError(errorMessage(error));
			}
			last = error;
			if (tick.budget.retriesUsed >= tick.retries.limit) {
				tick.budget.exhausted = true;
				tick.budget.error = error;
				break;
			}
			if (pastTickDeadline(tick)) {
				stopForDeadline(tick);
			}
			const wait = backoffMs(base, tick.budget.retriesUsed, tick.retries.backoff);
			tick.budget.retriesUsed += 1;
			console.log(
				JSON.stringify({ event: "d1_step_retry", step: name, attempt: tick.budget.retriesUsed, delayMs: wait }),
			);
			await sleep(wait);
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

type Method = "all" | "run" | "first";

function invoke(db: D1Database, method: Method, sql: string, params: readonly unknown[]): Promise<unknown> {
	const prepared = db.prepare(sql);
	const statement =
		params.length === 0
			? prepared
			: (prepared.bind as (this: D1PreparedStatement, ...values: unknown[]) => D1PreparedStatement).apply(
					prepared,
					[...params],
				);
	if (method === "all") {
		return statement.all();
	}
	if (method === "run") {
		return statement.run();
	}
	return statement.first();
}

export async function d1Query<T>(
	step: D1QueryStep,
	retry: boolean,
	method: Method,
	sql: string,
	params: readonly unknown[],
	bypassBudget = false,
): Promise<T> {
	if (step.tick?.budget.exhausted && !bypassBudget) {
		throw budgetError(step.tick.budget);
	}
	// One deadline for the whole tick. Past it, no new write or read starts.
	// Lease release passes bypassBudget so it can run from finally.
	// A stop throws. Callers must not treat it as an empty result.
	if (!bypassBudget && step.tick && pastTickDeadline(step.tick)) {
		stopForDeadline(step.tick);
	}
	const run = () => invoke(step.db, method, sql, params);
	if (!retry || !step.tick) {
		return run() as Promise<T>;
	}
	const name = sql.trim().split(/\s+/, 1)[0]?.toLowerCase() || "d1";
	return d1Step(name, step.tick, run) as Promise<T>;
}
