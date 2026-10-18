import { MAX_K, MIN_SEARCH_SCORE } from "../config/instance.ts";
import { SEEDS } from "../config/seed.ts";
import type { Citation } from "../config/types.ts";

const STOP_WORDS = new Set([
	"what",
	"are",
	"the",
	"best",
	"practices",
	"for",
	"to",
	"a",
	"an",
	"of",
	"and",
	"or",
	"vs",
	"how",
	"do",
	"should",
	"when",
	"with",
	"in",
	"on",
	"after",
	"user",
	"like",
	"look",
	"work",
	"patterns",
	"displaying",
	"display",
	"manage",
	"confirm",
	"handle",
	"use",
]);

const REFERENCE_SEGMENT = /^(api|props|properties|tokens|design-tokens|changelog)$/;

export function normalizePageUrl(value: string): string {
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

function segments(url: string): string[] {
	try {
		return new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
	} catch {
		return [];
	}
}

export function isReferencePage(url: string, passage: string): boolean {
	if (segments(url).some((segment) => REFERENCE_SEGMENT.test(segment.replace(/\.html$|\.md$/i, "")))) {
		return true;
	}
	const pipes = passage.split("|").length - 1;
	return pipes >= 8 && /\b(props?|properties|tokens?)\b/i.test(passage);
}

function queryNamesSystem(query: string): boolean {
	const hay = ` ${query.toLowerCase()} `;
	return SEEDS.some((seed) => {
		const source = seed.source.toLowerCase();
		const id = seed.id.toLowerCase();
		return hay.includes(source) || hay.includes(` ${id} `) || hay.includes(` ${id.replace(/-/g, " ")} `);
	});
}

function subjectTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function segmentMatches(segment: string, token: string): boolean {
	const bare = segment.replace(/\.html$|\.md$/i, "");
	return bare === token || bare === `${token}s` || bare.startsWith(`${token}-`) || bare.endsWith(`-${token}`);
}

function subjectMatch(url: string, tokens: readonly string[]): boolean {
	const parts = segments(url);
	return tokens.some((token) => parts.some((segment) => segmentMatches(segment, token)));
}

function tier(hit: Citation, query: string): number {
	if (isReferencePage(hit.url, hit.passage)) {
		return 2;
	}
	if (queryNamesSystem(query) && subjectMatch(hit.url, subjectTokens(query))) {
		return 0;
	}
	return 1;
}

export function rankCitations(citations: readonly Citation[], query: string, k?: number): Citation[] {
	const limit = k === undefined ? MAX_K : Math.min(MAX_K, Math.max(1, k));
	const best = new Map<string, Citation>();
	for (const hit of citations) {
		if (hit.score < MIN_SEARCH_SCORE) {
			continue;
		}
		const key = normalizePageUrl(hit.url);
		const current = best.get(key);
		if (!current || hit.score > current.score) {
			best.set(key, hit);
		}
	}
	return [...best.values()]
		.sort((left, right) => {
			const band = tier(left, query) - tier(right, query);
			if (band !== 0) {
				return band;
			}
			return right.score - left.score;
		})
		.slice(0, limit);
}
