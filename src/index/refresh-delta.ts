import { isLlmsIndexFile, isStaticAsset } from "../crawl/links.ts";

export function sitemapLocs(xml: string): string[] {
	const locs: string[] = [];
	for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
		const loc = match[1]?.trim();
		if (loc) {
			locs.push(loc);
		}
	}
	return locs;
}

export function robotsSitemaps(text: string): string[] {
	const urls: string[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
		const url = match?.[1];
		if (url) {
			urls.push(url);
		}
	}
	return urls;
}

export function isSitemapIndex(xml: string): boolean {
	return /<sitemapindex[\s>]/i.test(xml);
}

export function isSitemapFile(url: string): boolean {
	try {
		const path = new URL(url).pathname.toLowerCase();
		return path.endsWith(".xml") && path.includes("sitemap");
	} catch {
		return false;
	}
}

export function urlsToSeed(input: {
	startUrl: string;
	sitemapLocs: readonly string[];
	pageLinks: readonly string[];
	admit: (url: string) => string | null;
}): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	const add = (value: string) => {
		const admitted = input.admit(value);
		if (!admitted || seen.has(admitted) || isSitemapFile(admitted) || isLlmsIndexFile(admitted) || isStaticAsset(admitted)) {
			return;
		}
		seen.add(admitted);
		urls.push(admitted);
	};
	add(input.startUrl);
	for (const url of input.sitemapLocs) {
		add(url);
	}
	for (const url of input.pageLinks) {
		add(url);
	}
	return urls;
}
