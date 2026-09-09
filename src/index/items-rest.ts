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
	const form = new FormData();
	form.append("file", new Blob([content], { type: "text/markdown" }), key);
	form.append("metadata", JSON.stringify(metadata));
	form.append("wait_for_completion", "true");
	const response = await fetch(itemsUrl(auth), {
		method: "POST",
		headers: { authorization: `Bearer ${auth.apiToken}` },
		body: form,
	});
	const data = await readJson(response);
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
	for (;;) {
		const url = new URL(itemsUrl(auth));
		url.searchParams.set("page", String(page));
		url.searchParams.set("per_page", "50");
		url.searchParams.set("source", "builtin");
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${auth.apiToken}` },
		});
		const data = await readJson(response);
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
	}
	return items;
}

export async function deleteItem(auth: ItemsAuth, itemId: string): Promise<void> {
	const response = await fetch(itemsUrl(auth, `/${itemId}`), {
		method: "DELETE",
		headers: { authorization: `Bearer ${auth.apiToken}` },
	});
	if (!response.ok && response.status !== 404) {
		throw new Error(`item delete failed ${itemId}: ${JSON.stringify(await readJson(response))}`);
	}
}
