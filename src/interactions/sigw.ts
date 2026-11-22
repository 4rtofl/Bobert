import type {
	APIInteraction,
	APIInteractionResponse,
	APIMessageComponentInteraction,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	PermissionFlags,
	TextInputStyle,
} from "../discord/constants";
import {
	fetchSigwKeyInfo,
	rememberSigwKey,
	SIGW_PROVIDERS,
	type SigwKeyInfo,
	type SigwProvider,
	sigwState,
} from "../llm/sigw";
import { logEvent } from "../log";
import { saveSigwKey } from "../store/sigw-key";
import { normalizeInput, PRINTABLE_ASCII, readTextInput } from "./input";

/**
 * /sigw: Bobertが使うsigwのキーの登録(#135。仕様: docs/spec/behavior.md「sigwキーの登録」)。
 * キーはBobert全体で1つ。使えるのは、サーバー管理の権限を持つ人だけ。画面はすべて本人にだけ見せる
 */

export const SIGW_COMMAND_NAME = "sigw";
export const SIGW_COMMAND_DESCRIPTION =
	"Bobertが使うsigwキーの登録(サーバー管理者用)";
/** ボタンと入力画面のIDの頭 */
export const SIGW_ID_PREFIX = "sigw:";
const REGISTER_ID = `${SIGW_ID_PREFIX}register`;
const MODAL_ID = `${SIGW_ID_PREFIX}modal`;
const KEY_INPUT_ID = "key";

/** sigwのキーの頭 */
const KEY_PREFIX = "sgk_";

const NO_PERMISSION =
	"このコマンドは、サーバー管理の権限を持つ人だけが使えます。";
const PANEL_NOTE =
	"-# このキーは、Bobertを入れたすべてのサーバーで使います。返答、エージェント、動画、「Jevに聞く」は、このキーでsigwを通して呼びます。";
const MALFORMED_KEY = "キーの形が違います。sgk_ で始まるキーを貼ってください。";
const UNREACHABLE =
	"sigwにキーを確かめられませんでした。少し待ってから、もう一度試してください。";

const PROVIDER_LABELS: Record<SigwProvider, string> = {
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	typesafe: "TypeSafe",
};

/** /sigw: 登録したキーの状態と、登録のボタンを見せる */
export async function sigwCommand(
	interaction: APIInteraction,
	env: Env,
): Promise<APIInteractionResponse> {
	if (!isServerManager(interaction)) {
		return ephemeral(NO_PERMISSION);
	}
	const state = await sigwState(env);
	const lines =
		state.key === null
			? ["**Bobertが使うsigwキー**: 未登録"]
			: [
					`**Bobertが使うsigwキー**: 登録済み(末尾 ${state.last4})`,
					`- 呼べるプロバイダ: ${providerList(state.providers)}`,
				];
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content: [...lines, PANEL_NOTE].join("\n"),
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Primary,
							custom_id: REGISTER_ID,
							label:
								state.key === null ? "sigwキーを登録" : "sigwキーを登録し直す",
						},
					],
				},
			],
		},
	};
}

/** 「sigwキーを登録」のボタン: キーを入れる画面を開く。知らないボタンならnull */
export function sigwComponent(
	interaction: APIMessageComponentInteraction,
): APIInteractionResponse | null {
	if (interaction.data.custom_id !== REGISTER_ID) {
		return null;
	}
	if (!isServerManager(interaction)) {
		return ephemeral(NO_PERMISSION);
	}
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: MODAL_ID,
			title: "sigwキーの登録",
			components: [
				{
					type: ComponentType.Label,
					label: "sigwキー",
					description: "sigwのWeb UIで発行したキー(sgk_…)",
					component: {
						type: ComponentType.TextInput,
						custom_id: KEY_INPUT_ID,
						style: TextInputStyle.Short,
						required: true,
						max_length: 200,
					},
				},
			],
		},
	};
}

/**
 * 入力画面の送信: キーの形を確かめ、sigwに問い合わせて、使えるキーなら保存する。知らない画面ならnull。
 * 問い合わせはService Bindingで、すぐに返るので、保留にしない
 */
export async function submitSigwModal(
	interaction: APIModalSubmitInteraction,
	env: Env,
	userId: string,
	now = Date.now(),
): Promise<APIInteractionResponse | null> {
	if (interaction.data.custom_id !== MODAL_ID) {
		return null;
	}
	if (!isServerManager(interaction)) {
		return ephemeral(NO_PERMISSION);
	}
	const key = normalizeInput(readTextInput(interaction, KEY_INPUT_ID) ?? "");
	if (
		!key.startsWith(KEY_PREFIX) ||
		key.length === KEY_PREFIX.length ||
		!PRINTABLE_ASCII.test(key)
	) {
		logEvent("interactions", "sigw_key_malformed", { userId });
		return ephemeral(MALFORMED_KEY);
	}
	let info: SigwKeyInfo;
	try {
		info = await fetchSigwKeyInfo(env, key, userId);
	} catch (error) {
		logEvent("interactions", "sigw_key_check_failed", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		return ephemeral(UNREACHABLE);
	}
	if (info.status === "rejected") {
		logEvent("interactions", "sigw_key_rejected", { userId });
		return ephemeral(`sigwがこのキーを受け付けませんでした。${info.message}`);
	}
	const last4 = info.last4 || key.slice(-4);
	await saveSigwKey(env, {
		key,
		last4,
		providers: [...info.providers],
		registeredBy: userId,
		registeredAt: now,
	});
	rememberSigwKey(env, key, last4, info.providers, now);
	logEvent("interactions", "sigw_key_registered", {
		userId,
		providers: [...info.providers],
	});
	return ephemeral(
		`sigwキーを登録しました。呼べるプロバイダ: ${providerList(info.providers)}`,
	);
}

/** 呼べるプロバイダを「、」でつなぐ。1つもなければ「なし」 */
function providerList(providers: ReadonlySet<SigwProvider>): string {
	const names = SIGW_PROVIDERS.filter((provider) =>
		providers.has(provider),
	).map((provider) => PROVIDER_LABELS[provider]);
	return names.length === 0 ? "なし" : names.join("、");
}

/**
 * サーバー管理の権限(か、管理者の権限)を持っているか。コマンドの権限の既定でも絞っているが、
 * サーバーの設定(連携サービス)で誰でも使えるように変えられるので、ここでも確かめる
 */
function isServerManager(interaction: APIInteraction): boolean {
	const permissions = BigInt(interaction.member?.permissions ?? "0");
	return (
		(permissions & PermissionFlags.Administrator) !== 0n ||
		(permissions & PermissionFlags.ManageGuild) !== 0n
	);
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}
