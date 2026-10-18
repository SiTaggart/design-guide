export const SYSTEM_IDS = [
	"paste",
	"primer",
	"uswds",
	"govuk",
	"nhs",
	"antd",
	"gitlab-pajamas",
	"patternfly",
	"cloudscape",
	"vanilla",
	"siemens-ix",
	"backpack",
	"garden",
	"ouds-web",
] as const;

export type SystemId = (typeof SYSTEM_IDS)[number];

export type Seed = {
	id: SystemId;
	source: string;
	/** Extra names. A one-word name matches only with this casing. A phrase matches in any case. */
	aliases?: readonly string[];
	/** The one-word source matches only with its written capitalization. */
	matchCase?: boolean;
	/** The short name is also an ordinary English word. It counts as the system only as a proper name, or alongside a design word. */
	commonWord?: boolean;
	startUrl: string;
	fallbackStartUrl?: string;
	includePatterns?: string[];
	excludePatterns?: string[];
	indexUrlSuffixes?: string[];
	render?: boolean;
	includeSubdomains?: boolean;
};

export type CrawlCounts = {
	total: number;
	finished: number;
	skipped: number;
	disallowed: number;
	errored: number;
};

export type Citation = {
	passage: string;
	source: string;
	url: string;
	system: string;
	score: number;
};

export type SearchParams = {
	query: string;
	/** Upper bound on returned pages. Omitted means every passage at or above the floor, up to MAX_K. */
	k?: number;
	system?: SystemId;
};

export type SearchResponse = {
	results: Citation[];
};

export type SearchChunk = {
	text?: string;
	score?: unknown;
	scoring_details?: {
		vector_score?: unknown;
		reranking_score?: unknown;
	};
	item?: {
		key?: string;
		metadata?: Record<string, unknown>;
	};
};

export function isSystemId(value: string): value is SystemId {
	return (SYSTEM_IDS as readonly string[]).includes(value);
}
