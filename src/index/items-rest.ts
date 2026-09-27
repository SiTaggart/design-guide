export type ItemRecord = {
	id: string;
	key: string;
	status?: string;
};

export type ItemsAuth = {
	accountId: string;
	apiToken: string;
	instanceId: string;
};

function itemsUrl(auth: ItemsAuth, suffix = ""): string {
	return `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai-search/instances/${auth.instanceId}/items${suffix}`;
}

function instanceUrl(auth: ItemsAuth): string {
	return `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai-search/instances/${auth.instanceId}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
const RETRYABLE_ITEM_CODES = new Set([1015, 7009, 7114]);
const ALREADY_EXISTS_CODE = 7042;

export class ItemApiError extends Error {
	readonly code: number | null;
	readonly overload: boolean;

	constructor(message: string, code: number | null) {
		super(message);
		this.name = "ItemApiError";
		this.code = code;
		this.overload = code !== null && RETRYABLE_ITEM_CODES.has(code);
	}
}

export function isItemOverload(error: unknown): boolean {
	return error instanceof ItemApiError && error.overload;
}

export type ItemRequestOptions = {
	sleep?: (ms: number) => Promise<void>;
	onOverload?: () => void;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && /^[0-9]+$/.test(value)) {
		return Number(value);
	}
	return null;
}

function itemErrorCode(data: Record<string, unknown>, expected?: number): number | null {
	const errors = data.errors;
	if (!Array.isArray(errors)) {
		return null;
	}
	for (const error of errors) {
		if (!error || typeof error !== "object") {
			continue;
		}
		const code = errorCode((error as { code?: unknown }).code);
		if (code === null) {
			continue;
		}
		if (expected === undefined || code === expected) {
			return code;
		}
	}
	return null;
}

function retryableItemCode(data: Record<string, unknown>): number | null {
	const code = itemErrorCode(data);
	return code !== null && RETRYABLE_ITEM_CODES.has(code) ? code : null;
}

async function withItemRetries(
	request: () => Promise<Response>,
	options?: ItemRequestOptions,
): Promise<{ response: Response; data: Record<string, unknown> }> {
	let response: Response | undefined;
	let data: Record<string, unknown> = {};
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
		response = await request();
		data = await readJson(response);
		const code = retryableItemCode(data);
		if (code !== null) {
			options?.onOverload?.();
		}
		if (response.ok || code === null || attempt === RETRY_DELAYS_MS.length) {
			return { response, data };
		}
		await (options?.sleep ?? sleep)(RETRY_DELAYS_MS[attempt] ?? 16_000);
	}
	if (!response) {
		throw new Error("item request was not sent");
	}
	return { response, data };
}

async function cfFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			const response = await fetch(url, init);
			if ((response.status === 429 || response.status === 503) && attempt < RETRY_DELAYS_MS.length) {
				await sleep(RETRY_DELAYS_MS[attempt] ?? 16_000);
				continue;
			}
			return response;
		} catch (error) {
			lastError = error;
			if (attempt === RETRY_DELAYS_MS.length) {
				throw error;
			}
			await sleep(RETRY_DELAYS_MS[attempt] ?? 16_000);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getInstance(auth: ItemsAuth): Promise<boolean> {
	const response = await fetch(instanceUrl(auth), {
		headers: { authorization: `Bearer ${auth.apiToken}` },
	});
	if (response.status === 404) {
		return false;
	}
	if (!response.ok) {
		throw new Error(`instance get failed ${response.status}: ${JSON.stringify(await readJson(response))}`);
	}
	return true;
}

export async function createInstance(auth: ItemsAuth): Promise<void> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai-search/instances`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${auth.apiToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				id: auth.instanceId,
				rewrite_query: false,
				chunk_size: 256,
				fusion_method: "rrf",
				index_method: { vector: true, keyword: true },
				custom_metadata: [
					{ field_name: "system", data_type: "text" },
					{ field_name: "source", data_type: "text" },
					{ field_name: "source_url", data_type: "text" },
				],
			}),
		},
	);
	if (!response.ok) {
		throw new Error(`instance create failed ${response.status}: ${JSON.stringify(await readJson(response))}`);
	}
}

export async function ensureInstance(auth: ItemsAuth): Promise<void> {
	if (await getInstance(auth)) {
		return;
	}
	await createInstance(auth);
}

export async function uploadItem(
	auth: ItemsAuth,
	key: string,
	content: string,
	metadata: Record<string, string>,
	options?: ItemRequestOptions,
): Promise<ItemRecord> {
	const form = () => {
		const body = new FormData();
		body.append("file", new Blob([content], { type: "text/markdown" }), key);
		body.append("metadata", JSON.stringify(metadata));
		body.append("wait_for_completion", "true");
		return body;
	};
	const { response, data } = await withItemRetries(
		() =>
			cfFetch(itemsUrl(auth), {
				method: "POST",
				headers: { authorization: `Bearer ${auth.apiToken}` },
				body: form(),
			}),
		options,
	);
	if (!response.ok) {
		if (itemErrorCode(data, ALREADY_EXISTS_CODE) === ALREADY_EXISTS_CODE) {
			return { id: key, key };
		}
		throw new ItemApiError(
			`item upload failed ${key}: ${JSON.stringify(data.errors ?? data)}`,
			itemErrorCode(data),
		);
	}
	const result = data.result as ItemRecord;
	if (!result?.id || !result.key) {
		throw new Error(`item upload returned no id for ${key}`);
	}
	return result;
}

export async function listItems(auth: ItemsAuth, options?: ItemRequestOptions): Promise<ItemRecord[]> {
	const items: ItemRecord[] = [];
	let page = 1;
	for (;;) {
		const url = new URL(itemsUrl(auth));
		url.searchParams.set("page", String(page));
		url.searchParams.set("per_page", "50");
		url.searchParams.set("source", "builtin");
		const { response, data } = await withItemRetries(
			() =>
				cfFetch(url, {
					headers: { authorization: `Bearer ${auth.apiToken}` },
				}),
			options,
		);
		if (!response.ok) {
			throw new ItemApiError(`item list failed: ${JSON.stringify(data.errors ?? data)}`, itemErrorCode(data));
		}
		const result = (data.result as ItemRecord[]) ?? [];
		items.push(...result);
		const info = (data.result_info ?? {}) as { count?: number; total_count?: number };
		if (result.length === 0 || items.length >= (info.total_count ?? items.length)) {
			break;
		}
		page += 1;
	}
	return items;
}

export async function deleteItem(
	auth: ItemsAuth,
	itemId: string,
	options?: ItemRequestOptions,
): Promise<void> {
	const { response, data } = await withItemRetries(
		() =>
			cfFetch(itemsUrl(auth, `/${itemId}`), {
				method: "DELETE",
				headers: { authorization: `Bearer ${auth.apiToken}` },
			}),
		options,
	);
	if (!response.ok && response.status !== 404) {
		throw new ItemApiError(
			`item delete failed ${itemId}: ${JSON.stringify(data.errors ?? data)}`,
			itemErrorCode(data),
		);
	}
}
