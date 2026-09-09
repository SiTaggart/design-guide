import { isSystemId } from "../src/config/types.ts";
import { reindex, reindexExitCode } from "../src/index/reindex.ts";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

const only = process.env.SYSTEM;
if (only && !isSystemId(only)) {
	throw new Error(`SYSTEM must be a seed id, got ${only}`);
}

const results = await reindex(
	{
		accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
		apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
		instanceId: process.env.INSTANCE_ID,
	},
	only && isSystemId(only) ? only : undefined,
);

console.log(JSON.stringify(results, null, 2));
process.exitCode = reindexExitCode(results);
