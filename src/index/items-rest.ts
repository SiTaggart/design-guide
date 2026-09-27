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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasRateLimitError(data: Record<string, unknown>): boolean {
	const errors = data.errors;
	if (!Array.isArray(errors)) {
		return false;
	}
	return errors.some((error) => {
		if (!error || typeof error !== "object") {
			return false;
		}
		return (error as { code?: unknown }).code === 1015;
	});
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
): Promise<ItemRecord> {
	const form = () => {
		const body = new FormData();
		body.append("file", new Blob([content], { type: "text/markdown" }), key);
		body.append("metadata", JSON.stringify(metadata));
		body.append("wait_for_completion", "true");
		return body;
	};
	let response = await cfFetch(itemsUrl(auth), {
		method: "POST",
		headers: { authorization: `Bearer ${auth.apiToken}` },
		body: form(),
	});
	let data = await readJson(response);
	for (let retry = 0; !response.ok && hasRateLimitError(data) && retry < RETRY_DELAYS_MS.length; retry += 1) {
		await sleep(RETRY_DELAYS_MS[retry] ?? 16_000);
		response = await cfFetch(itemsUrl(auth), {
			method: "POST",
			headers: { authorization: `Bearer ${auth.apiToken}` },
			body: form(),
		});
		data = await readJson(response);
	}
	if (!response.ok) {
		throw new Error(`item upload failed ${key}: ${JSON.stringify(data.errors ?? data)}`);
	}
	const result = data.result as ItemRecord;
	if (!result?.id || !result.key) {
		throw new Error(`item upload returned no id for ${key}`);
	}
	return result;
}

export async function listItems(auth: ItemsAuth): Promise<ItemRecord[]> {
	const items: ItemRecord[] = [];
	let page = 1;
	let pageRetries = 0;
	for (;;) {
		const url = new URL(itemsUrl(auth));
		url.searchParams.set("page", String(page));
		url.searchParams.set("per_page", "50");
		url.searchParams.set("source", "builtin");
		const response = await cfFetch(url, {
			headers: { authorization: `Bearer ${auth.apiToken}` },
		});
		const data = await readJson(response);
		if (!response.ok && hasRateLimitError(data) && pageRetries < RETRY_DELAYS_MS.length) {
			await sleep(RETRY_DELAYS_MS[pageRetries] ?? 16_000);
			pageRetries += 1;
			continue;
		}
		if (!response.ok) {
			throw new Error(`item list failed: ${JSON.stringify(data.errors ?? data)}`);
		}
		const result = (data.result as ItemRecord[]) ?? [];
		items.push(...result);
		const info = (data.result_info ?? {}) as { count?: number; total_count?: number };
		if (result.length === 0 || items.length >= (info.total_count ?? items.length)) {
			break;
		}
		page += 1;
		pageRetries = 0;
	}
	return items;
}

export async function deleteItem(auth: ItemsAuth, itemId: string): Promise<void> {
	const response = await cfFetch(itemsUrl(auth, `/${itemId}`), {
		method: "DELETE",
		headers: { authorization: `Bearer ${auth.apiToken}` },
	});
	if (!response.ok && response.status !== 404) {
		throw new Error(`item delete failed ${itemId}: ${JSON.stringify(await readJson(response))}`);
	}
}
