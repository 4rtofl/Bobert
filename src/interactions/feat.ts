import type {
	APIActionRowComponent,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
} from "discord-api-types/v10";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { logEvent } from "../log";
import {
	getRegisteredProviders,
	getUserSettings,
	type UserSettings,
	updateUserSettings,
} from "../store/users";
import { VIDEO_FEATURE_LABEL, VIDEO_KEY_MISSING } from "../video/texts";

/** /feat のボタンのIDの頭 */
export const FEAT_BUTTON_PREFIX = "feat:";

/** /feat で切り替えられる機能(仕様: docs/spec/behavior.md「決定事項」) */
const FEATURES = [
	{
		setting: "featWebSearch",
		customId: `${FEAT_BUTTON_PREFIX}web_search`,
		label: "Web検索",
	},
	{
		setting: "featUsageDisplay",
		customId: `${FEAT_BUTTON_PREFIX}usage_display`,
		label: "利用量の表示",
	},
	{
		setting: "featVideo",
		customId: `${FEAT_BUTTON_PREFIX}video`,
		label: VIDEO_FEATURE_LABEL,
		// 動画は本人のAnthropicのアカウントで作るので、キーがなければONにできない
		needsAnthropicKey: VIDEO_KEY_MISSING,
	},
] as const satisfies readonly {
	setting: keyof UserSettings;
	customId: string;
	label: string;
	/** ONにするのにAnthropicのキーが要る機能なら、キーがない人に見せる案内 */
	needsAnthropicKey?: string;
}[];

/** /feat: 機能ごとのON/OFFのボタンを、本人にだけ見せる */
export async function featCommand(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const settings = await getUserSettings(env.DB, userId);
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, ...featMessage(settings) },
	};
}

/** ボタンを押したとき: その機能のON/OFFを切り替え、ボタンの表示を新しくする。知らないボタンならnull */
export async function toggleFeature(
	env: Env,
	userId: string,
	customId: string,
): Promise<APIInteractionResponse | null> {
	const feature = FEATURES.find((candidate) => candidate.customId === customId);
	if (!feature) {
		return null;
	}
	const settings = await getUserSettings(env.DB, userId);
	const enabled = !settings[feature.setting];
	if (
		enabled &&
		"needsAnthropicKey" in feature &&
		!(await getRegisteredProviders(env.DB, userId)).has("anthropic")
	) {
		logEvent("interactions", "feature_key_missing", {
			userId,
			feature: feature.setting,
		});
		return {
			type: InteractionResponseType.UpdateMessage,
			data: featMessage(settings, feature.needsAnthropicKey),
		};
	}
	await updateUserSettings(env.DB, userId, { [feature.setting]: enabled });
	logEvent("interactions", "feature_toggled", {
		userId,
		feature: feature.setting,
		enabled,
	});
	return {
		type: InteractionResponseType.UpdateMessage,
		data: featMessage({ ...settings, [feature.setting]: enabled }),
	};
}

/** ボタンを並べたメッセージ。ONは緑、OFFは灰色のボタンにする。noticeを渡すと、ボタンの上の文を置き換える */
function featMessage(
	settings: UserSettings,
	notice = "使う機能を、ボタンで切り替えてください。",
): {
	content: string;
	components: APIActionRowComponent<APIComponentInMessageActionRow>[];
} {
	return {
		content: notice,
		components: [
			{
				type: ComponentType.ActionRow,
				components: FEATURES.map((feature) => {
					const enabled = settings[feature.setting];
					return {
						type: ComponentType.Button,
						custom_id: feature.customId,
						style: enabled ? ButtonStyle.Success : ButtonStyle.Secondary,
						label: `${feature.label}: ${enabled ? "ON" : "OFF"}`,
					};
				}),
			},
		],
	};
}
