import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { getUserSettings } from "../src/store/users";
import {
	guildInteraction,
	openRouterOnlyEnv,
	sendInteraction,
	userFactory,
} from "./helpers";

/** 新しいユーザー(テストごとに別の人にする) */
const newUser = userFactory(700);

function featCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "14", name: "feat", type: 1 },
		user,
	);
}

/** ボタンを押す */
function press(user: APIUser, customId: string) {
	return guildInteraction(
		InteractionType.MessageComponent,
		{ custom_id: customId, component_type: ComponentType.Button },
		user,
	);
}

describe("/feat", () => {
	it("機能ごとのON/OFFのボタンを、本人にだけ見せる。ONは緑、OFFは灰色", async () => {
		const body = await sendInteraction(featCommand(await newUser()));

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toBe("使う機能を、ボタンで切り替えてください。");
		// 既定は、Web検索と利用量の表示がOFF。画像とファイルの読み取りは、常にONなのでボタンがない
		expect(body.data.components[0].components).toEqual([
			{
				type: ComponentType.Button,
				custom_id: "feat:web_search",
				style: ButtonStyle.Secondary,
				label: "Web検索: OFF",
			},
			{
				type: ComponentType.Button,
				custom_id: "feat:usage_display",
				style: ButtonStyle.Secondary,
				label: "利用量の表示: OFF",
			},
			{
				type: ComponentType.Button,
				custom_id: "feat:video",
				style: ButtonStyle.Secondary,
				label: "動画の作成: OFF",
			},
		]);
	});

	it("ボタンを押すと、その機能のON/OFFを切り替えて保存し、ボタンの表示を新しくする", async () => {
		const user = await newUser();

		const first = await sendInteraction(press(user, "feat:usage_display"));

		expect(first.type).toBe(InteractionResponseType.UpdateMessage);
		expect(first.data.content).toBe("使う機能を、ボタンで切り替えてください。");
		expect(first.data.components[0].components[1]).toMatchObject({
			style: ButtonStyle.Success,
			label: "利用量の表示: ON",
		});
		expect((await getUserSettings(env.DB, user.id)).featUsageDisplay).toBe(
			true,
		);

		const second = await sendInteraction(press(user, "feat:web_search"));

		expect(
			second.data.components[0].components.map(
				(button: { label: string }) => button.label,
			),
		).toEqual(["Web検索: ON", "利用量の表示: ON", "動画の作成: OFF"]);
		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.featUsageDisplay).toBe(true);
		expect(settings.featWebSearch).toBe(true);
	});

	it("動画の作成は、BobertにAnthropicのsigwのキーがなければ、ONにせずに知らせる", async () => {
		const user = await newUser();

		const body = await sendInteraction(
			press(user, "feat:video"),
			openRouterOnlyEnv(),
		);

		expect(body.type).toBe(InteractionResponseType.UpdateMessage);
		expect(body.data.content).toBe(
			"いまはAIを呼び出せません。Bobertの管理者に知らせてください。",
		);
		expect(body.data.components[0].components[2]).toMatchObject({
			label: "動画の作成: OFF",
		});
		expect((await getUserSettings(env.DB, user.id)).featVideo).toBe(false);
	});

	it("本人のキーがなくても、動画の作成をONにできる", async () => {
		const user = await newUser();

		const on = await sendInteraction(press(user, "feat:video"));

		expect(on.data.components[0].components[2]).toMatchObject({
			style: ButtonStyle.Success,
			label: "動画の作成: ON",
		});
		expect((await getUserSettings(env.DB, user.id)).featVideo).toBe(true);
	});
});
