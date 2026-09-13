import { MIN_SEARCH_SCORE } from "../config/instance.ts";
import type { Citation, SearchChunk } from "../config/types.ts";

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function httpsUrl(value: string): string | null {
	if (!value.startsWith("https://")) {
		return null;
	}
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

export function parseSearchScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	if (value < 0 || value > 1) {
		return undefined;
	}
	return value;
}

export function keepScoredChunks(chunks: SearchChunk[]): SearchChunk[] {
	return chunks.filter((chunk) => {
		const score = parseSearchScore(chunk.score);
		return score !== undefined && score >= MIN_SEARCH_SCORE;
	});
}

export function mapChunks(chunks: SearchChunk[]): Citation[] {
	const results: Citation[] = [];
	for (const chunk of chunks) {
		const passage = asString(chunk.text);
		const metadata = chunk.item?.metadata ?? {};
		const source = asString(metadata.source) || asString(chunk.item?.key);
		const url = httpsUrl(asString(metadata.source_url));
		const score = parseSearchScore(chunk.score);
		if (!passage || !source || !url || score === undefined || score < MIN_SEARCH_SCORE) {
			continue;
		}
		results.push({
			passage,
			source,
			url,
			system: asString(metadata.system),
			score,
		});
	}
	return results;
}
