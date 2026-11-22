/**
 * sigw(4rtofl/si-gateway)を通したAIの呼び出し(仕様: docs/spec/llm-cost.md「AIの呼び出しと費用の負担」)。
 * AnthropicもOpenRouterも、Jev(TypeSafe)も、Bobert用のsigwのキー1つで、Service Binding(env.SIGW)から呼ぶ。
 * キーは、サーバー管理者が /sigw で登録し、D1に暗号化して保存する(src/store/sigw-key.ts)。
 * 費用を払う人(返答を頼んだ人)のDiscordのIDを、呼び出しのたびに x-sigw-user ヘッダーで渡す。
 * sigwが記録し、毎月まとめて精算する。
 */
import Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "../log";
import { loadSigwKey } from "../store/sigw-key";
import type { Provider } from "../store/users";

/**
 * AIを呼び出せないとき(Bobertに、使えるsigwのキーがない)の知らせ。
 * 利用者には直せないので、管理者に知らせてもらう
 */
export const AI_UNAVAILABLE_TEXT =
	"いまはAIを呼び出せません。Bobertの管理者に知らせてください。";

/** sigwの中継の入口。Service Bindingで呼ぶので、ホスト名は何でもよい */
const SIGW_ORIGIN = "https://sigw";
const ANTHROPIC_BASE_URL = `${SIGW_ORIGIN}/anthropic`;
const OPENROUTER_BASE_URL = `${SIGW_ORIGIN}/openrouter/api/v1`;
const TYPESAFE_BASE_URL = `${SIGW_ORIGIN}/typesafe/v1`;
/** キーの情報(末尾4文字と、呼べるプロバイダ)を返す入口 */
const KEY_INFO_URL = `${SIGW_ORIGIN}/sigw/key`;

/** 費用を払う人を、sigwに伝えるヘッダー */
const USER_HEADER = "x-sigw-user";

/** sigwのキーで呼べるプロバイダ。sigwの /sigw/key が返す名前 */
export type SigwProvider = Provider | "typesafe";
/** 画面に並べる順 */
export const SIGW_PROVIDERS: readonly SigwProvider[] = [
	"anthropic",
	"openrouter",
	"typesafe",
];

/** sigwのキーの状態。キーと呼べるプロバイダを、少しの間覚えておく */
interface SigwState {
	/** 登録したキー。登録していなければnull */
	key: string | null;
	/** キーの末尾4文字。登録していなければnull */
	last4: string | null;
	/** 呼べるプロバイダ。キーがない、またはsigwに断られたら空 */
	providers: ReadonlySet<SigwProvider>;
	/** この状態を使ってよい期限(ミリ秒) */
	expiresAt: number;
}

/** キーと呼べるプロバイダを覚えておく時間。ほかのWorkerで登録し直したときも、この時間で切り替わる */
const STATE_TTL_MS = 60_000;
/** sigwに問い合わせられなかったとき、前の結果で続ける時間(過ぎたら、また問い合わせる) */
const RETRY_AFTER_MS = 10_000;

/**
 * 覚えている状態。Workerの実行環境(isolate)ごとに持つ。Durable Objectも、それぞれで持つ。
 * env.SIGW ごとに分けて覚える(テストで、sigwの偽物を差し替えた環境と混ざらないように)
 */
let states = new WeakMap<object, SigwState>();

/** sigw経由でAIを呼ぶ人。userIdは、その呼び出しの費用を払う人のDiscordのID */
export interface SigwCaller {
	env: Env;
	userId: string;
}

/**
 * sigwのキーの状態を返す。覚えている状態が古ければ、D1のキーを読み、sigwに呼べるプロバイダを問い合わせる。
 * sigwに問い合わせられなければ(つながらない、5xxなど)、前に問い合わせた結果か、なければ登録したときの結果で続ける
 */
export async function sigwState(
	env: Env,
	now = Date.now(),
): Promise<Omit<SigwState, "expiresAt">> {
	const cached = states.get(env.SIGW);
	if (cached !== undefined && now < cached.expiresAt) {
		return cached;
	}
	const stored = await loadSigwKey(env);
	if (stored === null) {
		return remember(env, {
			key: null,
			last4: null,
			providers: new Set(),
			expiresAt: now + STATE_TTL_MS,
		});
	}
	const info = await fetchSigwKeyInfo(env, stored.key).catch(
		(error: unknown) => ({
			status: "unreachable" as const,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	switch (info.status) {
		case "ok":
			return remember(env, {
				key: stored.key,
				last4: info.last4 || stored.last4,
				providers: info.providers,
				expiresAt: now + STATE_TTL_MS,
			});
		case "rejected":
			// キーが取り消された、など。どのプロバイダも呼べない
			logEvent("sigw", "key_rejected", { message: info.message });
			return remember(env, {
				key: stored.key,
				last4: stored.last4,
				providers: new Set(),
				expiresAt: now + STATE_TTL_MS,
			});
		case "unreachable": {
			logEvent("sigw", "key_info_unavailable", { error: info.error });
			const fallback =
				cached !== undefined && cached.key === stored.key
					? cached.providers
					: toProviders(stored.providers);
			return remember(env, {
				key: stored.key,
				last4: stored.last4,
				providers: fallback,
				expiresAt: now + RETRY_AFTER_MS,
			});
		}
	}
}

/**
 * 登録したキーの状態を、すぐに覚え直す(/sigw で登録したとき。この実行環境では、すぐに新しいキーを使う)。
 * ほかの実行環境は、覚えている時間(1分)が過ぎてから切り替わる
 */
export function rememberSigwKey(
	env: Env,
	key: string,
	last4: string,
	providers: ReadonlySet<SigwProvider>,
	now = Date.now(),
): void {
	remember(env, { key, last4, providers, expiresAt: now + STATE_TTL_MS });
}

/** 覚えている状態を忘れる(テスト用) */
export function forgetSigwState(): void {
	states = new WeakMap();
}

function remember(env: Env, state: SigwState): SigwState {
	states.set(env.SIGW, state);
	return state;
}

/**
 * 返答に使えるプロバイダ。sigwのキーで呼べるものだけ。全員で同じ
 * (Claudeの候補はAnthropicを呼べれば直接、呼べなければOpenRouter経由で呼ぶ)
 */
export async function sigwProviders(env: Env): Promise<ReadonlySet<Provider>> {
	const { providers } = await sigwState(env);
	const result = new Set<Provider>();
	for (const provider of providers) {
		if (provider !== "typesafe") {
			result.add(provider);
		}
	}
	return result;
}

/** Jev(TypeSafe)を呼べるか */
export async function jevAvailable(env: Env): Promise<boolean> {
	return (await sigwState(env)).providers.has("typesafe");
}

/** sigwに問い合わせた、キーの情報 */
export type SigwKeyInfo =
	| { status: "ok"; last4: string; providers: ReadonlySet<SigwProvider> }
	/** sigwがキーを断った(401)。messageは、sigwの文(「[sigw] 」で始まる) */
	| { status: "rejected"; message: string };

/**
 * sigwに、キーの末尾4文字と呼べるプロバイダを問い合わせる(GET /sigw/key)。
 * userIdを渡すと、問い合わせた人として x-sigw-user で送る。
 * つながらないときと、401以外の失敗は、例外にする
 */
export async function fetchSigwKeyInfo(
	env: Env,
	key: string,
	userId?: string,
): Promise<SigwKeyInfo> {
	const response = await env.SIGW.fetch(KEY_INFO_URL, {
		headers: {
			"x-api-key": key,
			...(userId === undefined ? {} : { [USER_HEADER]: userId }),
		},
	});
	if (response.status === 401) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: unknown };
		} | null;
		const message = body?.error?.message;
		return {
			status: "rejected",
			message: typeof message === "string" ? message : "",
		};
	}
	if (!response.ok) {
		throw new Error(`sigw key info failed: ${response.status}`);
	}
	const body = (await response.json()) as {
		last4?: unknown;
		providers?: unknown;
	};
	return {
		status: "ok",
		last4: typeof body.last4 === "string" ? body.last4 : "",
		providers: toProviders(Array.isArray(body.providers) ? body.providers : []),
	};
}

/** sigwが返した名前のうち、Bobertが使うプロバイダだけにする */
function toProviders(names: readonly unknown[]): ReadonlySet<SigwProvider> {
	return new Set(SIGW_PROVIDERS.filter((provider) => names.includes(provider)));
}

/** 呼び出しに使うキー。登録していなければ、例外にする(呼ぶ前に、呼べるプロバイダを確かめておく) */
async function requireSigwKey(env: Env): Promise<string> {
	const { key } = await sigwState(env);
	if (key === null) {
		throw new Error("sigw key is not registered");
	}
	return key;
}

/** sigw経由でAnthropicを呼ぶ、SDKのクライアント */
export function sigwAnthropicClient(
	{ env, userId }: SigwCaller,
	maxRetries?: number,
): Anthropic {
	return new Anthropic({
		// キーは、呼び出しのたびにD1から(覚えていれば、覚えたものを)読み、下のfetchで入れる。
		// SDKはキーがないと作れないので、仮の値を入れておく
		apiKey: "sigw-key-is-set-per-request",
		baseURL: ANTHROPIC_BASE_URL,
		fetch: async (input, init) => {
			const key = await requireSigwKey(env);
			const headers = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			);
			// このSDKは、apiKeyを Authorization: Bearer で送る。sigwの決まりに合わせて、x-api-key でも送る
			headers.set("Authorization", `Bearer ${key}`);
			headers.set("x-api-key", key);
			return env.SIGW.fetch(input, { ...init, headers });
		},
		defaultHeaders: { [USER_HEADER]: userId },
		...(maxRetries === undefined ? {} : { maxRetries }),
	});
}

/** sigw経由で、OpenRouterのAPI(pathは /chat/completions など)を呼ぶ */
export async function sigwOpenRouterFetch(
	{ env, userId }: SigwCaller,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
	const key = await requireSigwKey(env);
	return env.SIGW.fetch(`${OPENROUTER_BASE_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${key}`,
			[USER_HEADER]: userId,
		},
	});
}

/** sigw経由で、TypeSafeのAPI(Jev。pathは /systemone など)を呼ぶ。呼べるかは、呼ぶ前に jevAvailable で確かめる */
export async function sigwTypeSafeFetch(
	{ env, userId }: SigwCaller,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
	const key = await requireSigwKey(env);
	return env.SIGW.fetch(`${TYPESAFE_BASE_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${key}`,
			[USER_HEADER]: userId,
		},
	});
}

/** sigw自身が断ったときのエラーの文の始まり(プロバイダと同じ形のエラーで返ってくる) */
const SIGW_ERROR_PREFIX = "[sigw]";

/**
 * エラーの文が、sigw自身が断ったときのものなら、その文を返す(上限額に達した、など)。
 * sigwの文は、送った内容を含まないので、そのまま本人に見せられる。それ以外はnull
 */
export function sigwErrorMessage(message: unknown): string | null {
	return typeof message === "string" && message.startsWith(SIGW_ERROR_PREFIX)
		? message
		: null;
}
