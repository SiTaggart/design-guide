import type { WorkerEnv } from "./ai-search.ts";

export function reindexAuth(env: WorkerEnv): { accountId: string; apiToken: string } | null {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
		return null;
	}
	return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN };
}
