import { seedById } from "../config/seed.ts";
import { SYSTEM_IDS, type SystemId } from "../config/types.ts";
import type { WorkerEnv } from "../index/ai-search.ts";
import type { ParkRecord } from "../index/parks.ts";
import { emptyStatus, readStatus, type IndexStatusDocument } from "../index/status.ts";
import type { QueueDepths } from "../index/page-queue.ts";

export type SystemPhase = "empty" | "mid-fill" | "parked" | "stuck" | "live";
export type QueueMotion = "stuck" | "filling" | "idle";

const PHASE_LABEL: Record<SystemPhase, string> = {
	empty: "Empty",
	"mid-fill": "Filling",
	parked: "Parked",
	stuck: "Stuck",
	live: "Live",
};

export function queueMotion(queue: Pick<QueueDepths, "pending" | "claimed" | "failed">): QueueMotion {
	if (queue.failed > 0 && queue.pending + queue.claimed === 0) {
		return "stuck";
	}
	if (queue.pending + queue.claimed > 0) {
		return "filling";
	}
	return "idle";
}

export function systemPhase(input: {
	parked: boolean;
	pending: number;
	claimed: number;
	failed: number;
	done: number;
	lastCrawled: string | null;
	lastIndexed: string | null;
	lastDiscovered: string | null;
	error?: string;
}): SystemPhase {
	if (input.parked) {
		return "parked";
	}
	if (input.pending + input.claimed > 0) {
		return "mid-fill";
	}
	if (input.failed > 0 || Boolean(input.error)) {
		return "stuck";
	}
	if (input.done > 0 || input.lastIndexed || input.lastCrawled || input.lastDiscovered) {
		return "live";
	}
	return "empty";
}

export async function handleStatusPage(env: WorkerEnv): Promise<Response> {
	const document = env.INDEX ? await readStatus(env) : emptyStatus(true);
	return new Response(renderStatusPage(document), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export function renderStatusPage(document: IndexStatusDocument): string {
	const motion = queueMotion(document.queue);
	const rows = systemRows(document);
	const tally = tallyPhases(rows.map((row) => row.phase));
	const state = document.state ?? "—";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Design Guide index status</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: #1c1917; background: #f6f4f1; }
  header, main { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }
  header { padding-bottom: 0; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  p { margin: 0; }
  .lede { color: #57534e; }
  .banner { margin: 16px 0; padding: 12px 14px; border-radius: 10px; font-weight: 650; }
  .banner.stuck { background: #fde8e8; color: #7f1d1d; border: 1px solid #f0b4b4; }
  .banner.filling { background: #fff6e0; color: #7a4e00; border: 1px solid #ead7a1; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.02em; }
  .badge.running, .phase.mid-fill { background: #fff6e0; color: #7a4e00; }
  .badge.ok, .phase.live { background: #e7f6ee; color: #0d6b3d; }
  .badge.fail, .phase.stuck { background: #fde8e8; color: #7f1d1d; }
  .badge.none, .phase.empty { background: #eceae6; color: #57534e; }
  .phase.parked { background: #e7eaf3; color: #334155; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 16px 0; }
  .card, .panel { background: #fff; border: 1px solid #e7e2da; border-radius: 12px; padding: 12px 14px; }
  .card span, .muted { color: #78716c; font-size: 0.78rem; }
  .card strong { display: block; font-size: 1.25rem; margin-top: 2px; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .run-error { margin-top: 8px; color: #7f1d1d; font-weight: 650; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e7e2da; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0ebe4; vertical-align: top; }
  th { font-size: 0.75rem; color: #78716c; font-weight: 650; }
  tr[data-phase="stuck"] { background: #fff5f5; }
  tr[data-phase="mid-fill"] { background: #fffaf0; }
  tr[data-phase="parked"] { background: #f7f8fb; }
  tr[data-phase="live"] { background: #f4fbf7; }
  tr[data-phase="empty"] { color: #78716c; }
  .phase { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  .notes { color: #44403c; }
  @media (max-width: 800px) { .panels { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
</style>
</head>
<body data-queue="${motion}" data-state="${escapeHtml(state)}">
<header>
  <h1>Design Guide index status</h1>
  <p class="lede">Read-only. Each load reads the live index status.</p>
</header>
<main>
  ${banner(document, motion)}
  <p>${tally}</p>
  <section class="grid" aria-label="Rollup">
    ${card("state", state, `badge ${escapeHtml(document.state ?? "none")}`)}
    ${card("trigger", document.trigger ?? "—")}
    ${card("startedAt", document.startedAt ?? "—")}
    ${card("finishedAt", document.finishedAt ?? "—")}
    ${card("counts.systems", String(document.counts.systems))}
    ${card("counts.indexed", String(document.counts.indexed))}
    ${card("counts.parked", String(document.counts.parked))}
    ${card("counts.errors", String(document.counts.errors))}
    ${card("queue.pending", String(document.queue.pending))}
    ${card("queue.claimed", String(document.queue.claimed))}
    ${card("queue.failed", String(document.queue.failed))}
    ${card("queue.done", String(document.queue.done))}
  </section>
  <div class="panels">
    <section class="panel">
      <h2>Run</h2>
      <p>workflow <span data-field="workflowId">${escapeHtml(document.workflowId ?? "—")}</span></p>
      <p>seed hash <span data-field="seedHash">${escapeHtml(document.seedHash)}</span></p>
      <p>last indexed hash <span data-field="lastIndexedHash">${escapeHtml(document.lastIndexedHash ?? "—")}</span></p>
      ${document.unbound ? `<p class="run-error">Index KV is not bound.</p>` : ""}
      ${document.runError ? `<p class="run-error" data-field="runError">${escapeHtml(document.runError)}</p>` : ""}
    </section>
    <section class="panel" data-discover="${document.discover ? "active" : "none"}">
      <h2>Discover</h2>
      ${discoverBlock(document)}
    </section>
  </div>
  <h2 style="margin: 18px 0 8px">Systems</h2>
  <table>
    <thead>
      <tr>
        <th>system</th>
        <th>phase</th>
        <th>pending</th>
        <th>claimed</th>
        <th>failed</th>
        <th>done</th>
        <th>lastCrawled</th>
        <th>lastIndexed</th>
        <th>lastDiscovered</th>
        <th>notes</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(renderRow).join("\n")}
    </tbody>
  </table>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get("token");
  if (!token) return;
  setInterval(function () { location.reload(); }, 30000);
})();
</script>
</body>
</html>
`;
}

function banner(document: IndexStatusDocument, motion: QueueMotion): string {
	if (motion === "stuck") {
		return `<p class="banner stuck">Queue stuck. Failed pages remain and nothing is pending or claimed.</p>`;
	}
	if (motion === "filling") {
		return `<p class="banner filling">Filling. ${document.queue.pending} pending, ${document.queue.claimed} claimed.</p>`;
	}
	return "";
}

function card(field: string, value: string, className = ""): string {
	const cls = className ? ` class="${className}"` : "";
	return `<div class="card"><span>${escapeHtml(field)}</span><strong${cls} data-field="${field}">${escapeHtml(value)}</strong></div>`;
}

function discoverBlock(document: IndexStatusDocument): string {
	const discover = document.discover;
	if (!discover) {
		return `<p data-field="discover">No active discover</p>`;
	}
	return `<p>system <span data-field="discover.systemId">${escapeHtml(discover.systemId)}</span></p>
      <p>job <span data-field="discover.jobId">${escapeHtml(discover.jobId)}</span></p>
      <p>kind <span data-field="discover.kind">${escapeHtml(discover.kind)}</span></p>
      <p>trigger <span data-field="discover.trigger">${escapeHtml(discover.trigger)}</span></p>
      <p>started <span data-field="discover.startedAt">${escapeHtml(discover.startedAt)}</span></p>`;
}

type Row = {
	system: SystemId;
	label: string;
	phase: SystemPhase;
	pending: number;
	claimed: number;
	failed: number;
	done: number;
	lastCrawled: string | null;
	lastIndexed: string | null;
	lastDiscovered: string | null;
	notes: string;
};

function systemRows(document: IndexStatusDocument): Row[] {
	const freshness = new Map(document.freshness.map((row) => [row.system, row]));
	const errors = new Map(
		document.systems.filter((entry) => entry.error).map((entry) => [entry.system, entry.error ?? ""]),
	);
	return SYSTEM_IDS.map((system) => {
		const row = freshness.get(system);
		const park = document.parks[system];
		const error = errors.get(system);
		const pending = Number(row?.pending ?? 0);
		const claimed = Number(row?.claimed ?? 0);
		const failed = Number(row?.failed ?? 0);
		const done = Number(row?.done ?? 0);
		const lastCrawled = row?.lastCrawled ?? null;
		const lastIndexed = row?.lastIndexed ?? null;
		const lastDiscovered = row?.lastDiscovered ?? null;
		return {
			system,
			label: seedById(system).source,
			phase: systemPhase({
				parked: park !== undefined,
				pending,
				claimed,
				failed,
				done,
				lastCrawled,
				lastIndexed,
				lastDiscovered,
				error,
			}),
			pending,
			claimed,
			failed,
			done,
			lastCrawled,
			lastIndexed,
			lastDiscovered,
			notes: notes(park, error),
		};
	});
}

function notes(park: ParkRecord | undefined, error: string | undefined): string {
	const parts: string[] = [];
	if (park) {
		parts.push(`park ${park.reason} usable ${park.usable} at ${park.at}`);
	}
	if (error) {
		parts.push(error);
	}
	return parts.join(" · ");
}

function tallyPhases(phases: readonly SystemPhase[]): string {
	const counts: Record<SystemPhase, number> = {
		empty: 0,
		"mid-fill": 0,
		parked: 0,
		stuck: 0,
		live: 0,
	};
	for (const phase of phases) {
		counts[phase] += 1;
	}
	return (Object.keys(counts) as SystemPhase[])
		.map((phase) => `${PHASE_LABEL[phase]} ${counts[phase]}`)
		.join(" · ");
}

function renderRow(row: Row): string {
	return `<tr data-system="${row.system}" data-phase="${row.phase}">
        <td>${escapeHtml(row.system)} <span class="muted">${escapeHtml(row.label)}</span></td>
        <td><span class="phase ${row.phase}">${PHASE_LABEL[row.phase]}</span></td>
        <td data-field="pending">${row.pending}</td>
        <td data-field="claimed">${row.claimed}</td>
        <td data-field="failed">${row.failed}</td>
        <td data-field="done">${row.done}</td>
        <td data-field="lastCrawled">${escapeHtml(row.lastCrawled ?? "—")}</td>
        <td data-field="lastIndexed">${escapeHtml(row.lastIndexed ?? "—")}</td>
        <td data-field="lastDiscovered">${escapeHtml(row.lastDiscovered ?? "—")}</td>
        <td class="notes">${escapeHtml(row.notes || "—")}</td>
      </tr>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
