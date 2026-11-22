import { type ResolvedModel, resolveModel } from "../respond/model";
import { DEFAULT_USER_SETTINGS } from "../store/users";
import { chatWithAnthropic } from "./anthropic";
import { chatWithOpenRouter } from "./openrouter";
import { sigwProviders } from "./sigw";
import type { ChatRequest, ChatResult } from "./types";

/** 本人の費用で呼ぶモデルと、その呼び出し */
export interface UserModel {
	resolved: ResolvedModel;
	call: (request: ChatRequest) => Promise<ChatResult>;
}

/**
 * 本人の費用で、決まったモデル(候補の一覧のキー)をsigw経由で呼ぶ準備をする
 * (記憶のまとめと、知識のファイルの要約)。
 * Bobertにsigwのキーがあれば、Anthropicは直接、なければOpenRouter経由で呼ぶ。呼べなければnull
 */
export function userModel(
	env: Env,
	userId: string,
	modelKey: string,
): UserModel | null {
	const resolution = resolveModel(
		{ ...DEFAULT_USER_SETTINGS, modelKey },
		sigwProviders(env),
	);
	if (!resolution.ok) {
		return null;
	}
	const resolved = resolution.model;
	const caller = { env, userId };
	return {
		resolved,
		call: (request) =>
			resolved.provider === "anthropic"
				? chatWithAnthropic(caller, request)
				: chatWithOpenRouter(caller, request),
	};
}
