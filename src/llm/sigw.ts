/**
 * sigw(4rtofl/si-gateway)を通したAIの呼び出し(仕様: docs/spec/llm-cost.md「AIの呼び出しと費用の負担」)。
 * AnthropicもOpenRouterも、Jev(TypeSafe)も、Bobert用のsigwのキーで、Service Binding(env.SIGW)から呼ぶ。
 * 費用を払う人(返答を頼んだ人)のDiscordのIDを、呼び出しのたびに x-sigw-user ヘッダーで渡す。
 * sigwが記録し、毎月まとめて精算する。
 */
import Anthropic from "@anthropic-ai/sdk";
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

/** 費用を払う人を、sigwに伝えるヘッダー */
const USER_HEADER = "x-sigw-user";

/** sigw経由でAIを呼ぶ人。userIdは、その呼び出しの費用を払う人のDiscordのID */
export interface SigwCaller {
	env: Env;
	userId: string;
}

/**
 * Bobertが使えるプロバイダ。sigwのキーが入っているものだけ。全員で同じ
 * (Claudeの候補はAnthropicのキーがあれば直接、なければOpenRouter経由で呼ぶ)
 */
export function sigwProviders(env: Env): ReadonlySet<Provider> {
	const providers = new Set<Provider>();
	if (env.SIGW_ANTHROPIC_KEY) {
		providers.add("anthropic");
	}
	if (env.SIGW_OPENROUTER_KEY) {
		providers.add("openrouter");
	}
	return providers;
}

/** sigw経由でAnthropicを呼ぶ、SDKのクライアント */
export function sigwAnthropicClient(
	{ env, userId }: SigwCaller,
	maxRetries?: number,
): Anthropic {
	return new Anthropic({
		apiKey: env.SIGW_ANTHROPIC_KEY,
		baseURL: ANTHROPIC_BASE_URL,
		fetch: (input, init) => env.SIGW.fetch(input, init),
		// このSDKは、apiKeyを Authorization: Bearer で送る。sigwの決まりに合わせて、x-api-key でも送る
		defaultHeaders: {
			"x-api-key": env.SIGW_ANTHROPIC_KEY,
			[USER_HEADER]: userId,
		},
		...(maxRetries === undefined ? {} : { maxRetries }),
	});
}

/** sigw経由で、OpenRouterのAPI(pathは /chat/completions など)を呼ぶ */
export function sigwOpenRouterFetch(
	{ env, userId }: SigwCaller,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
	return env.SIGW.fetch(`${OPENROUTER_BASE_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${env.SIGW_OPENROUTER_KEY}`,
			[USER_HEADER]: userId,
		},
	});
}

/**
 * sigw経由で、TypeSafeのAPI(Jev。pathは /systemone など)を呼ぶ。
 * キーは、TypeSafe用のsigwのキー(SIGW_TYPESAFE_KEY)。空なら呼ばない(呼ぶ前に確かめる)
 */
export function sigwTypeSafeFetch(
	{ env, userId }: SigwCaller,
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
	return env.SIGW.fetch(`${TYPESAFE_BASE_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${env.SIGW_TYPESAFE_KEY}`,
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
