/**
 * ユーザーごとの設定(D1)。
 * 仕様: docs/spec/llm-cost.md「ユーザーごとの設定」
 */

/** AIの呼び出し先。どちらもsigwを通して呼ぶ(仕様: docs/spec/llm-cost.md「AIの呼び出しと費用の負担」) */
export type Provider = "anthropic" | "openrouter";

export interface UserSettings {
	/** NULLなら既定のモデル */
	modelKey: string | null;
	/** その他で入力されたモデルID(modelKeyが "custom" のとき) */
	customModelId: string | null;
	/** NULLならモデルの既定の思考の深さ */
	effort: string | null;
	/** /prompt で設定した自分用の指示 */
	customPrompt: string | null;
	featWebSearch: boolean;
	featUsageDisplay: boolean;
	/** 会話を要約した動画を作る道具を、AIに渡すか(仕様: docs/spec/behavior.md「動画の作成」) */
	featVideo: boolean;
}

/** まだ設定を変えていない人の設定 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
	modelKey: null,
	customModelId: null,
	effort: null,
	customPrompt: null,
	featWebSearch: false,
	featUsageDisplay: false,
	featVideo: false,
};

/**
 * usersの行のうち、設定に使う列。
 * feat_image_input(画像の読み取りのON/OFF)は、読み取りを常にONにしたので使わない(#59)
 */
interface UserRow {
	model_key: string | null;
	custom_model_id: string | null;
	effort: string | null;
	custom_prompt: string | null;
	feat_web_search: number;
	feat_usage_display: number;
	feat_video: number;
}

export async function getUserSettings(
	db: D1Database,
	userId: string,
): Promise<UserSettings> {
	const row = await db
		.prepare(
			`SELECT model_key, custom_model_id, effort, custom_prompt,
				feat_web_search, feat_usage_display, feat_video
			FROM users WHERE user_id = ?`,
		)
		.bind(userId)
		.first<UserRow>();
	if (row === null) {
		return DEFAULT_USER_SETTINGS;
	}
	return {
		modelKey: row.model_key,
		customModelId: row.custom_model_id,
		effort: row.effort,
		customPrompt: row.custom_prompt,
		featWebSearch: row.feat_web_search === 1,
		featUsageDisplay: row.feat_usage_display === 1,
		featVideo: row.feat_video === 1,
	};
}

/** 設定の項目と、usersの列 */
const SETTING_COLUMNS = {
	modelKey: "model_key",
	customModelId: "custom_model_id",
	effort: "effort",
	customPrompt: "custom_prompt",
	featWebSearch: "feat_web_search",
	featUsageDisplay: "feat_usage_display",
	featVideo: "feat_video",
} as const satisfies Record<keyof UserSettings, string>;

/** 設定を保存する。渡した項目だけを変える。usersの行がなければ作り、ほかの項目は既定のままにする */
export async function updateUserSettings(
	db: D1Database,
	userId: string,
	changes: Partial<UserSettings>,
	now = Date.now(),
): Promise<void> {
	const keys = (Object.keys(SETTING_COLUMNS) as (keyof UserSettings)[]).filter(
		(key) => changes[key] !== undefined,
	);
	if (keys.length === 0) {
		return;
	}
	// 列の名前はSETTING_COLUMNSのものだけを使う(入力をSQLに入れない)
	const columns = keys.map((key) => SETTING_COLUMNS[key]);
	const values = keys.map((key) => {
		const value = changes[key];
		return typeof value === "boolean" ? Number(value) : (value ?? null);
	});
	await db
		.prepare(
			`INSERT INTO users (user_id, ${columns.join(", ")}, created_at, updated_at)
			VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET
				${columns.map((column) => `${column} = excluded.${column}`).join(", ")},
				updated_at = excluded.updated_at`,
		)
		.bind(userId, ...values, now, now)
		.run();
}

/**
 * 設定をすべて消す(/delete)。GitHubとの連携も消す
 */
export async function deleteUserData(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM github_links WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM github_link_states WHERE user_id = ?").bind(userId),
	]);
}
