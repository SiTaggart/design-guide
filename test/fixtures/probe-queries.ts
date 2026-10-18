/** Live probes. The ranker does not read this file. */
export type ProbeQuery = {
	id: string;
	query: string;
	minSystems?: number;
	noReferenceInTop?: number;
	firstSystem?: string;
	firstUrl?: string;
	absentUrl?: string;
};

export const PROBE_QUERIES: readonly ProbeQuery[] = [
	{
		id: "p-paste-buttons",
		query: "how does Paste say to use buttons",
		firstSystem: "paste",
		firstUrl: "https://paste-dsys.com/components/button",
	},
	{
		id: "p-form-validation",
		query: "how to show validation problems once a form is submitted",
		minSystems: 3,
		noReferenceInTop: 5,
	},
	{
		id: "p-skeleton-spinner",
		query: "which loading placeholder should I pick, a skeleton or a spinner",
		minSystems: 2,
	},
	{
		id: "p-confirm-delete",
		query: "how do I ask the user before deleting something",
		minSystems: 2,
	},
	{
		id: "h-cloudscape-table",
		query: "cloudscape table guidance",
		firstSystem: "cloudscape",
		firstUrl: "https://cloudscape.design/components/table/",
		absentUrl: "https://cloudscape.design/llms.txt",
	},
	{
		id: "h-primer-dialog",
		query: "primer dialog guidance",
		firstSystem: "primer",
		firstUrl: "https://primer.style/product/components/dialog/guidelines/",
	},
];
