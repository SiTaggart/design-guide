import { createHash } from "node:crypto";

export function contentHash(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}
