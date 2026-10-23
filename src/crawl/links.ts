import type { Seed } from "../config/types.ts";

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function matchesPattern(url: string, pattern: string): boolean {
	return globToRegExp(pattern).test(url);
}

const STATIC_EXTENSION =
	/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp|eot|otf|ttf|woff2?|css|cjs|js|mjs|aac|avi|flac|m4a|m4v|mov|mp3|mp4|mpe?g|ogg|ogv|wav|webm|7z|bz2|gz|rar|tar|tgz|zip)$/i;

const STATIC_PATH =
	/\/(?:_next\/static|_next\/image|static\/media|static\/chunks|static\/css|static\/js|wp-content\/uploads|wp-includes)(?:\/|$)/i;

export function isStaticAsset(url: string): boolean {
	try {
		const path = new URL(url).pathname;
		if (STATIC_PATH.test(path)) {
			return true;
		}
		const file = path.split("/").filter(Boolean).pop() ?? "";
		return STATIC_EXTENSION.test(file);
	} catch {
		return false;
	}
}

export function isLlmsIndexFile(url: string): boolean {
	try {
		const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
		return /^llms.*\.txt$/i.test(segment);
	} catch {
		return false;
	}
}

export function pageKey(url: string): string {
	return canonicalLink(url, url) ?? url;
}

export function canonicalLink(value: string, base: string): string | null {
	try {
		const url = new URL(value, base);
		if (url.protocol !== "https:") {
			return null;
		}
		url.hash = "";
		url.search = "";
		if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
		}
		return url.toString();
	} catch {
		return null;
	}
}

export function linkAllowed(url: string, seed: Seed): boolean {
	let parsed: URL;
	let start: URL;
	try {
		parsed = new URL(url);
		start = new URL(seed.startUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") {
		return false;
	}
	const hostOk = seed.includeSubdomains
		? parsed.host === start.host || parsed.host.endsWith(`.${start.host}`)
		: parsed.host === start.host;
	if (!hostOk) {
		return false;
	}
	if (seed.includePatterns?.length && !seed.includePatterns.some((pattern) => matchesPattern(url, pattern))) {
		return false;
	}
	if (seed.excludePatterns?.some((pattern) => matchesPattern(url, pattern))) {
		return false;
	}
	return true;
}

export function fallbackScope(seed: Seed): Seed | null {
	if (!seed.fallbackStartUrl) {
		return null;
	}
	const prefix = seed.fallbackStartUrl.replace(/\/$/, "");
	return {
		...seed,
		startUrl: seed.fallbackStartUrl,
		includePatterns: [prefix, `${prefix}/**`],
	};
}

export function admittedUrl(url: string, seed: Seed): string | null {
	const canonical = canonicalLink(url, url);
	if (!canonical) {
		return null;
	}
	if (linkAllowed(canonical, seed)) {
		return canonical;
	}
	const fallback = fallbackScope(seed);
	if (fallback && linkAllowed(canonical, fallback)) {
		return canonical;
	}
	return null;
}

export function frontierLinks(markdown: string, pageUrl: string, seed: Seed): string[] {
	const found = new Set<string>();
	const raw = markdown.match(/https?:\/\/[^\s<>()"']+/g) ?? [];
	for (const match of raw) {
		const cleaned = match.replace(/[),.;]+$/g, "");
		const link = canonicalLink(cleaned, pageUrl);
		if (link && admittedUrl(link, seed) === link && !isLlmsIndexFile(link) && !isStaticAsset(link)) {
			found.add(link);
		}
	}
	for (const match of markdown.matchAll(/\[[^\]]*]\(([^)\s]+)\)/g)) {
		const link = canonicalLink(match[1] ?? "", pageUrl);
		if (link && admittedUrl(link, seed) === link && !isLlmsIndexFile(link) && !isStaticAsset(link)) {
			found.add(link);
		}
	}
	return [...found];
}
