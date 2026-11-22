/**
 * テスト用の、sigwの偽物。受けたリクエストを、ヘッダーもそのままに、プロバイダのURLへ送り直す。
 * 送り直しはその時点のfetchで行うので、mockFetch(test/helpers.ts)で置き換えたfetchが受け取る。
 * テストでは、プロバイダのホスト名(api.anthropic.com、openrouter.ai)で、どちらへの呼び出しかを見分ける
 */
const UPSTREAMS: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	openrouter: "https://openrouter.ai",
};

export const fakeSigw = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const [, provider, ...rest] = url.pathname.split("/");
		const upstream = UPSTREAMS[provider ?? ""];
		if (url.hostname !== "sigw" || upstream === undefined) {
			throw new Error(`Unexpected sigw request: ${request.url}`);
		}
		return fetch(
			new Request(`${upstream}/${rest.join("/")}${url.search}`, request),
		);
	},
	connect(): Socket {
		throw new Error("connect is not supported by the fake sigw");
	},
} as unknown as Service;
