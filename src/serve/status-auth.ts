import type { WorkerEnv } from "../index/ai-search.ts";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

export function statusUnauthorized(): Response {
	return new Response(JSON.stringify({ error: "unauthorized" }), {
		status: 401,
		headers: {
			...JSON_HEADERS,
			"www-authenticate": 'Bearer realm="design-guide-status"',
		},
	});
}

export function statusMethodNotAllowed(): Response {
	return new Response(JSON.stringify({ error: "method_not_allowed" }), {
		status: 405,
		headers: { ...JSON_HEADERS, allow: "GET" },
	});
}

export function statusTokenOk(request: Request, env: WorkerEnv): boolean {
	const expected = env.STATUS_TOKEN;
	if (!expected) {
		return false;
	}
	const header = request.headers.get("authorization") ?? "";
	const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
	const query = new URL(request.url).searchParams.get("token") ?? "";
	return safeEqual(expected, bearer) || safeEqual(expected, query);
}

function safeEqual(expected: string, provided: string): boolean {
	if (provided.length === 0 || expected.length !== provided.length) {
		return false;
	}
	let diff = 0;
	for (let index = 0; index < expected.length; index++) {
		diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
	}
	return diff === 0;
}
