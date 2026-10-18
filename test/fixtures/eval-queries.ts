/** Swap this list when the eval set changes. Candidate passages live in eval-candidates.json. */
export type EvalQuery = {
	id: string;
	query: string;
	/** Distinct systems required after the 0.6 reranker floor. Absent when this index misses that bar. */
	minSystems?: number;
	noReferenceInTop?: number;
	firstSystem?: string;
	firstUrl?: string;
};

export const EVAL_QUERIES: readonly EvalQuery[] = [
	{
		id: "q01-form-errors",
		query: "what are the best practices for displaying error messages to the user after a form submission",
		minSystems: 5,
		noReferenceInTop: 5,
	},
	{
		id: "q02-toast-alert",
		query: "when should I use a toast vs an inline alert",
	},
	{
		id: "q03-modal-focus",
		query: "how do I manage focus in an accessible modal dialog",
		minSystems: 2,
	},
	{
		id: "q04-button-hierarchy",
		query: "how should button hierarchy work, primary vs secondary vs tertiary",
		minSystems: 2,
		noReferenceInTop: 5,
	},
	{
		id: "q05-empty-state",
		query: "what should an empty state look like for a table with no data",
		minSystems: 2,
	},
	{
		id: "q06-skeleton",
		query: "skeleton loader or spinner for loading content",
		minSystems: 2,
	},
	{
		id: "q07-date-input",
		query: "how should a date input handle format and validation",
		minSystems: 2,
	},
	{
		id: "q08-destructive",
		query: "how do I confirm a destructive action like delete",
		minSystems: 2,
	},
	{
		id: "q09-data-table",
		query: "patterns for sorting, filtering and paginating a data table",
		minSystems: 2,
	},
	{
		id: "q10-paste-button",
		query: "Paste button guidance",
		firstSystem: "paste",
		firstUrl: "https://paste-dsys.com/components/button",
	},
];

export const NONSENSE_QUERIES = [
	{ id: "q11-gibberish", query: "zzqxv quantum flux capacitor sandwich" },
	{ id: "q12-banana", query: "best recipe for banana bread" },
] as const;
