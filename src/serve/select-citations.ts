import { MAX_K, MIN_SEARCH_SCORE } from "../config/instance.ts";
import type { Citation } from "../config/types.ts";
import { isLlmsIndexFile } from "../crawl/links.ts";

function pageUrl(value: string): string {
	const url = new URL(value);
	let path = url.pathname;
	if (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}
	path = path.replace(/\.html$/i, "").replace(/\.md$/i, "");
	const parts = path.split("/");
	const last = parts[parts.length - 1] ?? "";
	const hashed = last.match(/^(.*)-([A-Za-z0-9]{8,})$/);
	if (hashed?.[1] && hashed[2] && /[A-Z]/.test(hashed[2]) && /[a-z]/.test(hashed[2])) {
		parts[parts.length - 1] = hashed[1];
	}
	path = parts.join("/") || "/";
	return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

export function selectCitations(citations: readonly Citation[], k?: number): Citation[] {
	const limit = k === undefined ? MAX_K : Math.min(MAX_K, Math.max(1, k));
	const best = new Map<string, Citation>();
	for (const hit of citations) {
		if (isLlmsIndexFile(hit.url) || hit.score < MIN_SEARCH_SCORE) {
			continue;
		}
		const key = pageUrl(hit.url);
		const current = best.get(key);
		if (!current || hit.score > current.score) {
			best.set(key, hit);
		}
	}
	return [...best.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}
