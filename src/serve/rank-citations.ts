import { MAX_K, MIN_SEARCH_SCORE } from "../config/instance.ts";
import { SEEDS } from "../config/seed.ts";
import type { Citation } from "../config/types.ts";
import { isLlmsIndexFile } from "../crawl/links.ts";

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

function hasPhrase(query: string, phrase: string): boolean {
	const needle = phrase.toLowerCase().trim();
	if (!needle) {
		return false;
	}
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(query);
}

export function namedSystemIds(query: string): Set<string> {
	const named = new Set<string>();
	for (const seed of SEEDS) {
		const id = seed.id.toLowerCase();
		const phrases = [seed.source, id, id.replace(/-/g, " ")];
		const head = seed.source.split(/\s+/)[0] ?? "";
		if (head.length >= 3) {
			phrases.push(head);
		}
		for (const part of id.split("-")) {
			if (part.length >= 4) {
				phrases.push(part);
			}
		}
		if (phrases.some((phrase) => hasPhrase(query, phrase))) {
			named.add(seed.id);
		}
	}
	return named;
}

function band(hit: Citation, named: ReadonlySet<string>): number {
	const reference = isReferencePage(hit.url, hit.passage);
	if (named.has(hit.system)) {
		return reference ? 1 : 0;
	}
	return reference ? 3 : 2;
}

function identifyingWords(named: ReadonlySet<string>): Set<string> {
	const words = new Set<string>();
	for (const seed of SEEDS) {
		if (!named.has(seed.id)) {
			continue;
		}
		const id = seed.id.toLowerCase();
		words.add(id);
		for (const word of `${seed.source} ${id.replace(/-/g, " ")}`.toLowerCase().split(/[^a-z0-9]+/)) {
			if (word) {
				words.add(word);
			}
		}
	}
	return words;
}

function contentTokens(query: string, named: ReadonlySet<string>): string[] {
	const skip = identifyingWords(named);
	const tokens: string[] = [];
	const seen = new Set<string>();
	for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
		if (word.length < 4 || skip.has(word) || seen.has(word)) {
			continue;
		}
		seen.add(word);
		tokens.push(word);
	}
	return tokens;
}

function wordBases(word: string): Set<string> {
	const bases = new Set<string>([word]);
	if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) {
		bases.add(word.slice(0, -1));
	}
	if (word.length >= 5 && word.endsWith("es")) {
		bases.add(word.slice(0, -2));
	}
	if (word.length >= 5 && word.endsWith("ies")) {
		bases.add(`${word.slice(0, -3)}y`);
	}
	return bases;
}

function sameToken(token: string, segment: string): boolean {
	if (token === segment) {
		return true;
	}
	const bases = wordBases(token);
	if (bases.has(segment)) {
		return true;
	}
	for (const base of wordBases(segment)) {
		if (base === token || bases.has(base)) {
			return true;
		}
	}
	return false;
}

function pathAffinity(url: string, tokens: readonly string[]): number {
	if (tokens.length === 0) {
		return 0;
	}
	const parts = segments(url).map((segment) => segment.replace(/\.html$|\.md$/i, ""));
	const last = parts[parts.length - 1] ?? "";
	if (tokens.some((token) => sameToken(token, last))) {
		return 2;
	}
	if (parts.some((part) => tokens.some((token) => sameToken(token, part)))) {
		return 1;
	}
	return 0;
}

export function rankCitations(citations: readonly Citation[], query: string, k?: number): Citation[] {
	const named = namedSystemIds(query);
	const tokens = contentTokens(query, named);
	const limit = k === undefined ? MAX_K : Math.min(MAX_K, Math.max(1, k));
	const best = new Map<string, Citation>();
	for (const hit of citations) {
		if (hit.score < MIN_SEARCH_SCORE || isLlmsIndexFile(hit.url)) {
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
			const leftBand = band(left, named);
			const group = leftBand - band(right, named);
			if (group !== 0) {
				return group;
			}
			if (leftBand === 0) {
				const affinity = pathAffinity(right.url, tokens) - pathAffinity(left.url, tokens);
				if (affinity !== 0) {
					return affinity;
				}
			}
			return right.score - left.score;
		})
		.slice(0, limit);
}
