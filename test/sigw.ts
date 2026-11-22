/**
 * テスト用の、sigwの偽物。
 * - GET /sigw/key: 知っているキーなら、末尾4文字と呼べるプロバイダを返す。知らないキーなら401
 * - プロバイダへの中継: キー(Anthropicは x-api-key、ほかは Authorization: Bearer)を確かめてから、
 *   受けたリクエストを、ヘッダーもそのままに、プロバイダのURLへ送り直す。
 *   送り直しはその時点のfetchで行うので、mockFetch(test/helpers.ts)で置き換えたfetchが受け取る。
 *   テストでは、プロバイダのホスト名(api.anthropic.com、openrouter.ai、api.typesafe.ai)で、どちらへの呼び出しかを見分ける
 */
const UPSTREAMS: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	openrouter: "https://openrouter.ai",
	typesafe: "https://api.typesafe.ai",
};

/** テストでD1に登録しておく、Bobertのsigwのキー(test/setup.ts) */
export const TEST_SIGW_KEY = "sgk_test0000000000abcd";
/** sigwのキーで呼べる、すべてのプロバイダ */
export const ALL_SIGW_PROVIDERS = ["anthropic", "openrouter", "typesafe"];

/** sigwが知っているキーと、それぞれで呼べるプロバイダ */
export type FakeSigwKeys = Record<string, readonly string[]>;

/** sigwがキーを断ったときの、sigwの文 */
export const REJECTED_KEY_MESSAGE = "[sigw] このキーは使えません。";

/**
 * 偽物のsigw。keysは、sigwが知っているキーと、それぞれで呼べるプロバイダ。
 * keyInfoを渡すと、/sigw/key にはその応答を返す(つながらないときなどを試す)
 */
export function fakeSigwWith(
	keys: FakeSigwKeys = { [TEST_SIGW_KEY]: ALL_SIGW_PROVIDERS },
	options: {
		keyInfo?: (request: Request) => Response | Promise<Response>;
	} = {},
): Service {
	return {
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.hostname !== "sigw") {
				throw new Error(`Unexpected sigw request: ${request.url}`);
			}
			if (url.pathname === "/sigw/key") {
				if (options.keyInfo) {
					return options.keyInfo(request);
				}
				const key = request.headers.get("x-api-key") ?? "";
				const providers = keys[key];
				return providers === undefined
					? rejected()
					: Response.json({ last4: key.slice(-4), providers });
			}
			const [, provider = "", ...rest] = url.pathname.split("/");
			const upstream = UPSTREAMS[provider];
			if (upstream === undefined) {
				throw new Error(`Unexpected sigw request: ${request.url}`);
			}
			const key =
				provider === "anthropic"
					? request.headers.get("x-api-key")
					: request.headers.get("Authorization")?.replace(/^Bearer /, "");
			if (!keys[key ?? ""]?.includes(provider)) {
				return rejected();
			}
			return fetch(
				new Request(`${upstream}/${rest.join("/")}${url.search}`, request),
			);
		},
		connect(): Socket {
			throw new Error("connect is not supported by the fake sigw");
		},
	} as unknown as Service;
}

function rejected(): Response {
	return Response.json(
		{
			error: { type: "authentication_error", message: REJECTED_KEY_MESSAGE },
		},
		{ status: 401 },
	);
}

/** テストの既定のsigw。登録しておくキー(TEST_SIGW_KEY)で、すべてのプロバイダを呼べる */
export const fakeSigw = fakeSigwWith();
