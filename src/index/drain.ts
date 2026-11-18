import { createHash } from "node:crypto";
import type { SystemId } from "../config/types.ts";

export function pageItemKey(system: SystemId, url: string, attempts: number, stamp: string): string {
	const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
	const slot = createHash("sha256").update(`${attempts}\0${stamp}`).digest("hex").slice(0, 8);
	return `${system}/page/${digest}-${slot}.md`;
}
