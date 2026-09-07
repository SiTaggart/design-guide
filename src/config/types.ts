export const SYSTEM_IDS = [
	"paste",
	"primer",
	"react-spectrum",
	"carbon",
	"uswds",
	"govuk",
	"nhs",
	"antd",
	"gitlab-pajamas",
] as const;

export type SystemId = (typeof SYSTEM_IDS)[number];

export type Seed = {
	id: SystemId;
	source: string;
	startUrls: string[];
	includePatterns: string[];
	excludePatterns?: string[];
	fallbackStartUrls?: string[];
	limit: number;
	depth: number;
	render?: boolean;
	includeSubdomains?: boolean;
};

export type Citation = {
	passage: string;
	source: string;
	url: string;
	system: string;
};

export type SearchParams = {
	query: string;
	k: number;
	system?: SystemId;
};

export type SearchResponse = {
	results: Citation[];
};

export type SearchChunk = {
	text?: string;
	item?: {
		key?: string;
		metadata?: Record<string, unknown>;
	};
};

export function isSystemId(value: string): value is SystemId {
	return (SYSTEM_IDS as readonly string[]).includes(value);
}
