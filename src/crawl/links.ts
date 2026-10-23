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

function matchesExclude(url: string, pattern: string): boolean {
	return matchesPattern(url, pattern) || (pattern.endsWith("/**") && matchesPattern(url, pattern.slice(0, -3)));
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
		while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
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
	if (
		!isSeedRoot(url, seed) &&
		seed.includePatterns?.length &&
		!seed.includePatterns.some((pattern) => matchesPattern(url, pattern))
	) {
		return false;
	}
	if (seed.excludePatterns?.some((pattern) => matchesExclude(url, pattern))) {
		return false;
	}
	return true;
}

export function fallbackScope(seed: Seed): Seed | null {
	if (!seed.fallbackStartUrl) {
		return null;
	}
	const project = seed.fallbackStartUrl.replace(/\/$/, "");
	const contents = `${project}/**/contents`;
	return {
		...seed,
		startUrl: seed.fallbackStartUrl,
		includePatterns: [contents, `${contents}/**`],
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

function isSeedRoot(url: string, seed: Seed): boolean {
	const root = canonicalLink(seed.startUrl, seed.startUrl);
	const candidate = canonicalLink(url, url);
	return root !== null && candidate === root;
}

const BASE_HREF = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function openFence(line: string): { mark: string; size: number } | null {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match || (match[2].startsWith("`") && match[3].includes("`"))) {
		return null;
	}
	return { mark: match[2][0], size: match[2].length };
}

function closesFence(line: string, fence: { mark: string; size: number }): boolean {
	const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
	return match !== null && match[2][0] === fence.mark && match[2].length >= fence.size;
}

function maskMarkdownCode(markdown: string): string {
	let fence: { mark: string; size: number } | null = null;
	return markdown
		.split("\n")
		.map((line) => {
			if (fence) {
				if (closesFence(line, fence)) {
					fence = null;
				}
				return "";
			}
			const opened = openFence(line);
			if (opened) {
				fence = opened;
				return "";
			}
			return line.replace(/(`+)(?:(?!\1).)*?\1/g, (match) => " ".repeat(match.length));
		})
		.join("\n");
}

function directorySlashAllowed(resolvedHref: string, seed: Seed): boolean {
	let parsed: URL;
	try {
		parsed = new URL(resolvedHref);
	} catch {
		return false;
	}
	if (parsed.pathname.length <= 1 || !parsed.pathname.endsWith("/")) {
		return false;
	}
	if (linkAllowed(resolvedHref, seed)) {
		return true;
	}
	const fallback = fallbackScope(seed);
	return fallback !== null && linkAllowed(resolvedHref, fallback);
}

export function linkBase(pageUrl: string, markdown: string, seed: Seed): string {
	const match = maskMarkdownCode(markdown).match(BASE_HREF);
	const href = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!href) {
		return pageUrl;
	}
	try {
		const resolved = new URL(href, pageUrl);
		const sameOrigin = resolved.origin === new URL(pageUrl).origin;
		const admitted = admittedUrl(resolved.href, seed) !== null || directorySlashAllowed(resolved.href, seed);
		if (!sameOrigin || !admitted) {
			return pageUrl;
		}
		return resolved.href;
	} catch {
		return pageUrl;
	}
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
