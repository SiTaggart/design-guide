import { describe, expect, it } from "vitest";
import { seedById } from "../src/config/seed.ts";
import { SYSTEM_IDS } from "../src/config/types.ts";
import { admittedUrl } from "../src/crawl/links.ts";
import { applyRefresh, consumeQueue, conveyorTick, type FetchedPage } from "../src/index/conveyor.ts";
import { D1PageQueue } from "../src/index/page-queue.ts";
import { UrlQueue } from "../src/index/url-queue.ts";
import { memoryD1 } from "./helpers/d1.ts";
import { envWithIndex, memoryKV } from "./helpers/index-env.ts";

const NOW = "2026-10-30T00:10:54.000Z";
const BUTTON = "https://primer.style/product/button";
const BUTTON_SLASH = `${BUTTON}/`;
const BUTTON_QUERY = `${BUTTON}?view=1`;
const BUTTON_HASH = `${BUTTON}#usage`;
const PASCAL = "https://primer.style/Product/Button";
const LOOKBOOK = "https://primer.style/view-components/lookbook/inspect/primer/button";
const LOOKBOOK_LIST = "https://primer.style/view-components/components/button/_list";
const OCTICON = "https://primer.style/octicons/icon/shield-lock-24";
const DOCS = "https://primer.style/product/contribute/design/";
const GOVUK = "https://design-system.service.gov.uk/components/button/";
const USWDS = "https://designsystem.digital.gov/components/button";

function clock(ms = Date.parse(NOW)): { ms: number } {
	return { ms };
}

function page(status: number, body: string): FetchedPage {
	return { status, body };
}

describe("canonical inserts", () => {
	it("stores one queue row when the same page is slashed, queried, or anchored", async () => {
		const pageQueue = new UrlQueue(memoryD1());
		await pageQueue.enqueue(
			[BUTTON_SLASH, BUTTON_QUERY, BUTTON_HASH, PASCAL].map((url) => ({
				url,
				systemId: "primer" as const,
				op: "fetch" as const,
			})),
			clock(),
		);
		expect((await pageQueue.list()).map((row) => row.url).sort()).toEqual([BUTTON, PASCAL].sort());
	});

	it("stores sitemap index locs without a query or a trailing slash", async () => {
		const pageQueue = new UrlQueue(memoryD1());
		const index = "https://primer.style/sitemap_index.xml";
		await pageQueue.enqueue([{ url: index, systemId: "primer", op: "sitemap" }], clock());
		await consumeQueue({
			queue: pageQueue,
			now: NOW,
			limit: 5,
			clock: clock(),
			knownHashes: new Map(),
			knownUrls: new Set(),
			fetchPage: async () => page(200, "page"),
			fetchText: async () =>
				page(
					200,
					`<sitemapindex><sitemap><loc>https://primer.style/child.xml?from=index</loc></sitemap><sitemap><loc>https://primer.style/nested/</loc></sitemap></sitemapindex>`,
				),
			upload: async () => undefined,
			deletePage: async () => undefined,
		});
		const urls = (await pageQueue.list()).map((row) => row.url);
		expect(urls).toContain("https://primer.style/child.xml");
		expect(urls).toContain("https://primer.style/nested");
		expect(urls.some((url) => url.includes("?") || url.endsWith("nested/"))).toBe(false);
	});

	it("does not re-admit a slash twin or an excluded primer path on refresh", async () => {
		const pageQueue = new UrlQueue(memoryD1());
		await pageQueue.enqueue([{ url: BUTTON, systemId: "primer", op: "fetch" }], clock());
		await applyRefresh({
			queue: pageQueue,
			systemId: "primer",
			seed: seedById("primer"),
			known: [BUTTON_SLASH, LOOKBOOK, LOOKBOOK_LIST, OCTICON, DOCS],
			clock: clock(),
		});
		expect((await pageQueue.list()).map((row) => row.url).sort()).toEqual(
			[
				BUTTON,
				"https://primer.style/product/contribute/design",
				"https://primer.style/robots.txt",
				"https://primer.style/sitemap.xml",
				"https://primer.style/sitemap_index.xml",
			].sort(),
		);
	});

	it("stores one page_work row for slash and query spellings", async () => {
		const db = memoryD1();
		const pages = new D1PageQueue(db);
		await pages.enqueueUpsert(
			[
				{ systemId: "primer", url: BUTTON_SLASH, kind: "seed" },
				{ systemId: "primer", url: BUTTON_QUERY, kind: "seed" },
			],
			NOW,
		);
		const rows = await db.prepare("SELECT url FROM page_work WHERE system_id = ?").bind("primer").all<{ url: string }>();
		expect(rows.results.map((row) => row.url)).toEqual([BUTTON]);
	});

	it("copies a pending page_work row onto its canonical queue url and skips excluded primer paths", async () => {
		const db = memoryD1();
		const kv = memoryKV();
		const { env } = envWithIndex([], true, {
			INDEX: kv,
			PAGE_QUEUE: db,
			CLOUDFLARE_ACCOUNT_ID: "acct",
			CLOUDFLARE_API_TOKEN: "token",
		});
		for (const id of SYSTEM_IDS) {
			await db.prepare("INSERT INTO system_mark (system_id, last_discovered) VALUES (?, ?)").bind(id, NOW).run();
		}
		const insertedAt = "2026-10-25T06:15:00.000Z";
		for (const [systemId, url] of [
			["primer", BUTTON_SLASH],
			["primer", LOOKBOOK],
			["primer", OCTICON],
			["govuk", GOVUK],
			["uswds", USWDS],
		] as const) {
			await db
				.prepare(
					`INSERT INTO page_work (system_id, url, kind, status, enqueued_at, attempts)
					 VALUES (?, ?, 'seed', 'pending', ?, 0)`,
				)
				.bind(systemId, url, insertedAt)
				.run();
		}
		await conveyorTick(env, "*/5 * * * *", new Date(NOW), {
			listItems: async () => [],
			deadlineMs: Date.parse(NOW) - 1,
		});
		const queued = await db
			.prepare("SELECT system_id, url, enqueued_at FROM queue ORDER BY system_id, url")
			.all<{ system_id: string; url: string; enqueued_at: string }>();
		expect(queued.results).toEqual([
			{ system_id: "govuk", url: "https://design-system.service.gov.uk/components/button", enqueued_at: insertedAt },
			{ system_id: "primer", url: BUTTON, enqueued_at: insertedAt },
			{ system_id: "uswds", url: USWDS, enqueued_at: insertedAt },
		]);
	});

	it("stores one discover url and does not keep an excluded primer frontier", async () => {
		const db = memoryD1();
		const pages = new D1PageQueue(db);
		await pages.stageUrl("primer", BUTTON_SLASH);
		await pages.stageIndexable("primer", BUTTON_QUERY);
		await pages.addFrontier("primer", [BUTTON_HASH, LOOKBOOK, OCTICON, PASCAL]);
		const staged = await db.prepare("SELECT url FROM discover_url").all<{ url: string }>();
		const indexable = await db.prepare("SELECT url FROM discover_indexable").all<{ url: string }>();
		const frontier = await db.prepare("SELECT url FROM discover_frontier ORDER BY url").all<{ url: string }>();
		expect(staged.results.map((row) => row.url)).toEqual([BUTTON]);
		expect(indexable.results.map((row) => row.url)).toEqual([BUTTON]);
		expect(frontier.results.map((row) => row.url)).toEqual([BUTTON, PASCAL].sort());
	});

	it("admits primer docs and rejects the lookbook and octicon icon pages", () => {
		const primer = seedById("primer");
		expect(admittedUrl("https://primer.style/product/contribute/design/", primer)).toBe(
			"https://primer.style/product/contribute/design",
		);
		expect(admittedUrl("https://primer.style/brand/visual-assets", primer)).toBe(
			"https://primer.style/brand/visual-assets",
		);
		expect(admittedUrl("https://primer.style/foundations/icons", primer)).toBe("https://primer.style/foundations/icons");
		expect(admittedUrl("https://primer.style/accessibility/keyboard", primer)).toBe(
			"https://primer.style/accessibility/keyboard",
		);
		expect(admittedUrl(LOOKBOOK, primer)).toBeNull();
		expect(admittedUrl(LOOKBOOK_LIST, primer)).toBeNull();
		expect(admittedUrl(OCTICON, primer)).toBeNull();
		expect(admittedUrl(PASCAL, primer)).toBe(PASCAL);
	});
});
