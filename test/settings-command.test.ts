import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { clearModelInfoCache } from "../src/llm/model-info";
import { setMemoryEnabled } from "../src/store/memory";
import {
	DEFAULT_USER_SETTINGS,
	getUserSettings,
	updateUserSettings,
} from "../src/store/users";
import {
	editedMessage,
	type FetchCall,
	guildInteraction,
	mockFetch,
	mockModelApis,
	noSigwEnv,
	sendInteraction,
	userFactory,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

/** 新しいユーザー(テストごとに別の人にする) */
const newUser = userFactory(800);

function settingsCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "15", name: "settings", type: 1 },
		user,
	);
}

/** 書き換えたメッセージの行 */
function lines(calls: FetchCall[]): string[] {
	return (editedMessage(calls)?.content ?? "").split("\n");
}

describe("/settings", () => {
	it("今の設定を、本人にだけ見せる", async () => {
		const user = await newUser();
		const calls = mockModelApis([]);

		const body = await sendInteraction(settingsCommand(user));

		// 思考の深さは、モデル情報を見て決めることがあるので、まず保留の応答を返す
		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(editedMessage(calls)).toEqual({
			content: [
				"- モデル: Claude Haiku 5.5(Anthropicで直接呼ぶ)",
				"- 思考の深さ: low(既定)",
				"- Web検索: OFF",
				"- 利用量の表示: OFF",
				"- 自分用の指示: なし",
				"- 記憶: OFF",
			].join("\n"),
			components: [],
		});
	});

	it("変えた設定を書き、自分用の指示は先頭の50文字だけ出す", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, {
			modelKey: "gpt-6-luna",
			effort: "high",
			featWebSearch: true,
			featUsageDisplay: true,
			customPrompt: `${"あ".repeat(30)}\n${"い".repeat(30)}`,
		});
		const calls = mockModelApis([
			{
				id: "openai/gpt-6-luna",
				efforts: ["max", "xhigh", "high", "medium", "low", "none"],
			},
		]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toEqual([
			"- モデル: GPT-6 Luna(OpenRouter経由)",
			"- 思考の深さ: high",
			"- Web検索: ON",
			"- 利用量の表示: ON",
			// 改行は空白にする
			`- 自分用の指示: ${"あ".repeat(30)} ${"い".repeat(19)}…`,
			"- 記憶: OFF",
		]);
	});

	it("記憶は、コマンドを使ったサーバーでの設定を書く", async () => {
		const user = await newUser();
		// コマンドを使ったサーバー(900)ではON、ほかのサーバーではOFF
		await setMemoryEnabled(env.DB, user.id, "900", true);
		await setMemoryEnabled(env.DB, user.id, "901", false);
		const calls = mockModelApis([]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls).at(-1)).toBe("- 記憶: ON");
	});

	it("lowを選べないモデルでは、代わりに使う段階に「(既定)」を付ける", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { modelKey: "mistral-large-4" });
		const calls = mockModelApis([
			{ id: "mistralai/mistral-large-4-0", efforts: ["high", "none"] },
		]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toContain("- 思考の深さ: high(既定)");
	});

	it("思考の深さを選べないモデルでは、そう書く", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { modelKey: "mimo-v2.6-pro" });
		const calls = mockModelApis([{ id: "xiaomi/mimo-v2.6-pro" }]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toContain("- 思考の深さ: このモデルでは選べません");
	});

	it("Bobertにsigwのキーがなければ、モデルは使えないと書く", async () => {
		const calls = mockModelApis([]);

		await sendInteraction(settingsCommand(await newUser()), noSigwEnv());

		expect(lines(calls)).toEqual(
			expect.arrayContaining([
				"- モデル: Claude Haiku 5.5(いまは使えません)",
				"- 思考の深さ: low(既定)",
			]),
		);
	});

	it("モデル情報を取得できなければ、そう知らせる", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { modelKey: "glm-5.3" });
		const calls = mockFetch(({ url }) =>
			url.hostname === "openrouter.ai"
				? new Response(null, { status: 503 })
				: Response.json({}),
		);

		await sendInteraction(settingsCommand(user));

		expect(editedMessage(calls)).toEqual({
			content:
				"モデルの情報を取得できませんでした。少し待ってから、もう一度試してください。",
			components: [],
		});
	});
});

describe("キーの登録をなくした後(#128)", () => {
	it("登録したキーと、OpenRouterとの連携の途中の状態を保存していた表を消す", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('credentials', 'oauth_states')",
		).all();
		expect(results).toEqual([]);
	});

	it("GitHubとの連携の途中の状態の表は残す", async () => {
		const table = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_link_states'",
		).first();
		expect(table).not.toBeNull();
	});
});

describe("/delete", () => {
	it("確認のボタンを押すと、設定を消す", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { customPrompt: "敬語で" });

		const confirm = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "11", name: "delete", type: 1 },
				user,
			),
		);
		expect(confirm.data).toMatchObject({
			flags: MessageFlags.Ephemeral,
			content:
				"あなたの設定(モデルや自分用の指示など)を、すべて削除します。よろしいですか?",
		});
		expect(confirm.data.components[0].components[0].custom_id).toBe(
			"delete:confirm",
		);
		// 確かめるまでは消さない
		expect((await getUserSettings(env.DB, user.id)).customPrompt).toBe(
			"敬語で",
		);

		const done = await sendInteraction(
			guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: "delete:confirm", component_type: ComponentType.Button },
				user,
			),
		);
		expect(done).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: { content: "削除しました。", components: [] },
		});
		expect(await getUserSettings(env.DB, user.id)).toEqual(
			DEFAULT_USER_SETTINGS,
		);
	});
});
