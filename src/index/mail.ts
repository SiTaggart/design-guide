import type { SystemId } from "../config/types.ts";
import type { WorkerEnv } from "./ai-search.ts";
import type { Parks } from "./parks.ts";
import type { SystemReindexResult } from "./reindex.ts";
import {
	countsFrom,
	errorsFromResults,
	readStatus,
	runStateFrom,
	type ReindexParams,
} from "./status.ts";

export const INDEX_MAIL_TO = "simon.taggart@gmail.com";
export const INDEX_MAIL_FROM = "design-guide@simontaggart.com";
export const INDEX_STATUS_URL = "https://design-guide.me-2c5.workers.dev/status";

const STATUS_OPEN =
	"Open Status with the Worker secret STATUS_TOKEN (Authorization: Bearer, or ?token= on that URL locally). This mail does not include the secret.";
export const MAIL_STEP_RETRIES = {
	retries: { limit: 5, delay: "10 seconds" as const, backoff: "exponential" as const },
};

export type IndexMail = {
	from: typeof INDEX_MAIL_FROM;
	to: typeof INDEX_MAIL_TO;
	subject: string;
	text: string;
};

export function startIndexMail(params: Pick<ReindexParams, "trigger" | "workflowId" | "systems">): IndexMail {
	const systems = params.systems.length ? params.systems.join(", ") : "(none)";
	return {
		to: INDEX_MAIL_TO,
		from: INDEX_MAIL_FROM,
		subject: `design-guide index started (${params.trigger}) ${params.workflowId}`,
		text: [
			`Trigger: ${params.trigger}`,
			`Workflow: ${params.workflowId}`,
			`Systems: ${systems}`,
			`Status: ${INDEX_STATUS_URL}`,
			STATUS_OPEN,
		].join("\n"),
	};
}

export function finishIndexMail(
	params: Pick<ReindexParams, "trigger" | "workflowId">,
	results: readonly SystemReindexResult[],
	parks: Parks,
	runError?: string,
	unparked: readonly SystemId[] = [],
): IndexMail {
	const state = runError ? "fail" : runStateFrom(results);
	const counts = countsFrom(results, parks);
	const errors = errorsFromResults(results);
	const touched = results.map((result) => result.system);
	const parkLines =
		Object.keys(parks).length === 0
			? ["  (none)"]
			: Object.entries(parks).map(
					([system, record]) =>
						`  ${system}: ${record?.reason} usable=${record?.usable} at=${record?.at}`,
				);
	const errorLines = [
		...(runError ? [`  run: ${runError}`] : []),
		...(["crawl", "render", "index"] as const).flatMap((channel) =>
			errors[channel].map((entry) => `  ${channel} ${entry.system}: ${entry.message}`),
		),
	];
	const systemLines =
		results.length === 0
			? ["  (none)"]
			: results.map((result) => {
					const parts = [
						result.system,
						`indexed=${result.indexed}`,
						`usable=${result.usable ?? 0}`,
						`hitLimit=${result.hitLimit}`,
						`parked=${Boolean(result.parked)}`,
					];
					if (result.error) {
						parts.push(`error=${result.error}`);
					}
					return `  ${parts.join(" ")}`;
				});
	return {
		to: INDEX_MAIL_TO,
		from: INDEX_MAIL_FROM,
		subject: `design-guide index finished ${state} (${params.trigger}) ${params.workflowId}`,
		text: [
			`Trigger: ${params.trigger}`,
			`Workflow: ${params.workflowId}`,
			`State: ${state}`,
			`Systems touched: ${touched.length ? touched.join(", ") : "(none)"}`,
			...(unparked.length ? [`Unparked: ${unparked.join(", ")}`] : []),
			`Counts: systems=${counts.systems} indexed=${counts.indexed} parked=${counts.parked} errors=${counts.errors}`,
			"Parks:",
			...parkLines,
			"Errors:",
			...(errorLines.length ? errorLines : ["  (none)"]),
			"Per-system counts:",
			...systemLines,
			`Status: ${INDEX_STATUS_URL}`,
			STATUS_OPEN,
		].join("\n"),
	};
}

export async function sendIndexMail(
	env: WorkerEnv,
	mail: IndexMail,
): Promise<{ messageId: string } | { skipped: "unbound" }> {
	if (!env.EMAIL) {
		console.log(JSON.stringify({ event: "index_mail_skipped", reason: "unbound", subject: mail.subject }));
		return { skipped: "unbound" };
	}
	const result = await env.EMAIL.send({
		from: mail.from,
		to: mail.to,
		subject: mail.subject,
		text: mail.text,
	});
	console.log(
		JSON.stringify({ event: "index_mail_sent", subject: mail.subject, messageId: result.messageId }),
	);
	return { messageId: result.messageId };
}

export async function sendStartIndexMail(
	env: WorkerEnv,
	params: Pick<ReindexParams, "trigger" | "workflowId" | "systems">,
): Promise<{ messageId: string } | { skipped: "unbound" }> {
	return sendIndexMail(env, startIndexMail(params));
}

export async function sendFinishIndexMail(
	env: WorkerEnv,
	params: Pick<ReindexParams, "trigger" | "workflowId">,
	results: readonly SystemReindexResult[],
	runError?: string,
): Promise<{ messageId: string } | { skipped: "unbound" }> {
	const status = await readStatus(env);
	return sendIndexMail(env, finishIndexMail(params, results, status.parks, runError, status.unparked));
}

