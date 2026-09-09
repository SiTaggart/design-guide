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

export function mapChunks(chunks: SearchChunk[]): Citation[] {
	const results: Citation[] = [];
	for (const chunk of chunks) {
		const passage = asString(chunk.text);
		const metadata = chunk.item?.metadata ?? {};
		const source = asString(metadata.source) || asString(chunk.item?.key);
		const url = httpsUrl(asString(metadata.source_url));
		if (!passage || !source || !url) {
			continue;
		}
		results.push({
			passage,
			source,
			url,
			system: asString(metadata.system),
		});
	}
	return results;
}
