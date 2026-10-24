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
};

export type D1Tick = {
	retries: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
	budget: D1TickBudget;
};

export type D1QueueOptions = {
	retries?: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
	budget?: D1TickBudget;
};

export type D1QueryStep = {
	db: D1Database;
	tick?: D1Tick;
};

export function createD1TickBudget(): D1TickBudget {
	return { exhausted: false };
}

export function tickFrom(options?: D1QueueOptions): D1Tick | undefined {
	if (!options?.retries) {
		return undefined;
	}
	return {
		retries: options.retries,
		...(options.sleep ? { sleep: options.sleep } : {}),
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

export async function d1Step<T>(name: string, tick: D1Tick, run: () => Promise<T>): Promise<T> {
	if (tick.budget.exhausted) {
		throw budgetError(tick.budget);
	}
	const sleep = tick.sleep ?? defaultSleep;
	const base = delayMs(tick.retries.delay);
	let last: unknown;
	for (let attempt = 0; attempt <= tick.retries.limit; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (error instanceof NonRetryableError || !isTransientD1Error(error)) {
				throw error instanceof NonRetryableError ? error : new NonRetryableError(errorMessage(error));
			}
			last = error;
			if (attempt === tick.retries.limit) {
				tick.budget.exhausted = true;
				tick.budget.error = error;
				break;
			}
			const wait = backoffMs(base, attempt, tick.retries.backoff);
			console.log(JSON.stringify({ event: "d1_step_retry", step: name, attempt: attempt + 1, delayMs: wait }));
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
): Promise<T> {
	if (step.tick?.budget.exhausted) {
		throw budgetError(step.tick.budget);
	}
	const run = () => invoke(step.db, method, sql, params);
	if (!retry || !step.tick) {
		return run() as Promise<T>;
	}
	const name = sql.trim().split(/\s+/, 1)[0]?.toLowerCase() || "d1";
	return d1Step(name, step.tick, run) as Promise<T>;
}
