import { CRAWL_LIMIT } from "../config/instance.ts";

/** Stored by the older whole-site swap when a crawl stopped at the page cap. */
export function isCrawlCapError(error: string | undefined): boolean {
	return error !== undefined && /^crawl hit the \d+ page limit$/.test(error);
}

/** Real seed failure. A page-cap note is a truncation warning, not an error. */
export function seedFailure(error: string | undefined): string | undefined {
	if (!error || isCrawlCapError(error)) {
		return undefined;
	}
	return error;
}

export function capHitNote(pages: number, limit = CRAWL_LIMIT): string {
	return `cap hit: ${pages} pages, limit ${limit}`;
}

export function capHitPageCount(input: {
	pending: number;
	claimed: number;
	failed: number;
	done: number;
	crawlFinished?: number;
}): number {
	if (input.pending + input.claimed + input.failed === 0 && input.done > 0) {
		return input.done;
	}
	const queued = input.pending + input.claimed + input.failed + input.done;
	if (queued > 0) {
		return queued;
	}
	return input.crawlFinished ?? 0;
}
