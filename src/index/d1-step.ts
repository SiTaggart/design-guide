import { NonRetryableError } from "cloudflare:workflows";

export const D1_STEP_RETRIES = {
	limit: 3,
	delay: "10 seconds",
	backoff: "exponential",
} as const;

export type D1StepRetries = typeof D1_STEP_RETRIES;

export type D1QueueOptions = {
	retries?: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
};

type Policy = {
	retries: D1StepRetries;
	sleep?: (ms: number) => Promise<void>;
};

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

export async function d1Step<T>(name: string, policy: Policy, run: () => Promise<T>): Promise<T> {
	const sleep = policy.sleep ?? defaultSleep;
	const base = delayMs(policy.retries.delay);
	let last: unknown;
	for (let attempt = 0; attempt <= policy.retries.limit; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (error instanceof NonRetryableError || !isTransientD1Error(error)) {
				throw error instanceof NonRetryableError ? error : new NonRetryableError(errorMessage(error));
			}
			last = error;
			if (attempt === policy.retries.limit) {
				break;
			}
			const wait = backoffMs(base, attempt, policy.retries.backoff);
			console.log(JSON.stringify({ event: "d1_step_retry", step: name, attempt: attempt + 1, delayMs: wait }));
			await sleep(wait);
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

type Statement = {
	bind: (...params: unknown[]) => Statement;
	all: (...args: unknown[]) => Promise<unknown>;
	run: (...args: unknown[]) => Promise<unknown>;
	first: (...args: unknown[]) => Promise<unknown>;
};

function prepared(db: D1Database, sql: string, policy: Policy, params?: readonly unknown[]): Statement {
	const step = sql.trim().split(/\s+/, 1)[0]?.toLowerCase() || "d1";
	const invoke = (method: "all" | "run" | "first", args: readonly unknown[]) =>
		d1Step(step, policy, () => {
			const statement = db.prepare(sql) as unknown as Statement;
			const bound = params === undefined ? statement : statement.bind(...params);
			return bound[method](...args);
		});
	return {
		bind: (...next: unknown[]) => prepared(db, sql, policy, next),
		all: (...args: unknown[]) => invoke("all", args),
		run: (...args: unknown[]) => invoke("run", args),
		first: (...args: unknown[]) => invoke("first", args),
	};
}

export function retryingDatabase(
	db: D1Database,
	retries: D1StepRetries,
	sleep?: (ms: number) => Promise<void>,
): D1Database {
	const policy: Policy = { retries, ...(sleep ? { sleep } : {}) };
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "prepare") {
				return (sql: string) => prepared(target, sql, policy);
			}
			if (prop === "exec") {
				return (sql: string) => d1Step("exec", policy, () => target.exec(sql));
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
