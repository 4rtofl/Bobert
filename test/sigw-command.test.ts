import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
	PermissionFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import {
	forgetSigwState,
	jevAvailable,
	sigwOpenRouterFetch,
	sigwProviders,
	sigwState,
} from "../src/llm/sigw";
import { loadSigwKey, saveSigwKey } from "../src/store/sigw-key";
import {
	guildInteraction,
	mockFetch,
	sendInteraction,
	userFactory,
} from "./helpers";
import {
	ALL_SIGW_PROVIDERS,
	type FakeSigwKeys,
	fakeSigwWith,
	REJECTED_KEY_MESSAGE,
	TEST_SIGW_KEY,
} from "./sigw";

const newUser = userFactory(66000);

const NOTE =
	"-# このキーは、Bobertを入れたすべてのサーバーで使います。返答、エージェント、動画、「Jevに聞く」は、このキーでsigwを通して呼びます。";
const NO_PERMISSION =
	"このコマンドは、サーバー管理の権限を持つ人だけが使えます。";
const MALFORMED = "キーの形が違います。sgk_ で始まるキーを貼ってください。";
const NEW_KEY = "sgk_newkey0000000wxyz";

afterEach(async () => {
	vi.restoreAllMocks();
	// ほかのテストのために、登録しておくキーに戻す
	await saveSigwKey(env, {
		key: TEST_SIGW_KEY,
		last4: TEST_SIGW_KEY.slice(-4),
		providers: ALL_SIGW_PROVIDERS,
		registeredBy: "0",
		registeredAt: 0,
	});
	forgetSigwState();
});

/** sigwの偽物を差し替えた環境 */
function sigwEnv(
	keys: FakeSigwKeys = { [TEST_SIGW_KEY]: ALL_SIGW_PROVIDERS },
	options: Parameters<typeof fakeSigwWith>[1] = {},
): Env {
	return { ...env, SIGW: fakeSigwWith(keys, options) };
}

/** サーバーの中のInteraction。permissionsは、操作した人の権限 */
function interaction(
	type: number,
	data: unknown,
	user: APIUser,
	permissions: bigint,
) {
	const base = guildInteraction(type, data, user);
	return {
		...base,
		member: { ...base.member, permissions: String(permissions) },
	};
}

const MANAGER = PermissionFlags.ManageGuild;

function command(user: APIUser, permissions = MANAGER) {
	return interaction(
		InteractionType.ApplicationCommand,
		{ id: "1", name: "sigw", type: 1 },
		user,
		permissions,
	);
}

function registerButton(user: APIUser, permissions = MANAGER) {
	return interaction(
		InteractionType.MessageComponent,
		{ custom_id: "sigw:register", component_type: ComponentType.Button },
		user,
		permissions,
	);
}

function submit(user: APIUser, key: string, permissions = MANAGER) {
	return interaction(
		InteractionType.ModalSubmit,
		{
			custom_id: "sigw:modal",
			components: [
				{
					type: ComponentType.Label,
					component: {
						type: ComponentType.TextInput,
						custom_id: "key",
						value: key,
					},
				},
			],
		},
		user,
		permissions,
	);
}

function ephemeral(content: string) {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}

describe("/sigw のコマンドの登録", () => {
	it("サーバーの中だけで、サーバー管理の権限を持つ人に限って使える", () => {
		const sigw = COMMANDS.find((entry) => entry.name === "sigw");
		expect(sigw).toMatchObject({
			description: "Bobertが使うsigwキーの登録(サーバー管理者用)",
			default_member_permissions: String(PermissionFlags.ManageGuild),
			contexts: [0],
		});
		expect(helpText()).toContain(
			"- `/sigw`: Bobertが使うsigwキーの登録(サーバー管理者用)",
		);
	});
});

describe("/sigw の権限", () => {
	it("サーバー管理の権限がなければ、コマンドもボタンも入力画面も断る", async () => {
		const user = await newUser();
		mockFetch(() => Response.json({}));
		expect(await sendInteraction(command(user, 0n))).toEqual(
			ephemeral(NO_PERMISSION),
		);
		expect(
			await sendInteraction(
				registerButton(user, PermissionFlags.ManageChannels),
			),
		).toEqual(ephemeral(NO_PERMISSION));
		expect(await sendInteraction(submit(user, NEW_KEY, 0n))).toEqual(
			ephemeral(NO_PERMISSION),
		);
		// キーは置き換えない
		expect((await loadSigwKey(env))?.key).toBe(TEST_SIGW_KEY);
	});

	it("管理者の権限があれば使える", async () => {
		const user = await newUser();
		const response = await sendInteraction(
			command(user, PermissionFlags.Administrator),
		);
		expect(response.data.content).toContain("登録済み");
	});
});

describe("/sigw の画面", () => {
	it("登録したキーの末尾と、呼べるプロバイダを見せる", async () => {
		const user = await newUser();
		expect(await sendInteraction(command(user))).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: [
					"**Bobertが使うsigwキー**: 登録済み(末尾 abcd)",
					"- 呼べるプロバイダ: Anthropic、OpenRouter、TypeSafe",
					NOTE,
				].join("\n"),
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.Button,
								style: ButtonStyle.Primary,
								custom_id: "sigw:register",
								label: "sigwキーを登録し直す",
							},
						],
					},
				],
			},
		});
	});

	it("呼べるプロバイダは、sigwに問い合わせた結果で見せる", async () => {
		const user = await newUser();
		const response = await sendInteraction(
			command(user),
			sigwEnv({ [TEST_SIGW_KEY]: ["openrouter"] }),
		);
		expect(response.data.content).toContain("- 呼べるプロバイダ: OpenRouter\n");
	});

	it("登録していなければ、未登録と見せ、プロバイダの行は出さない", async () => {
		const user = await newUser();
		await env.DB.prepare("DELETE FROM sigw_key").run();
		forgetSigwState();
		const response = await sendInteraction(command(user));
		expect(response.data.content).toBe(
			["**Bobertが使うsigwキー**: 未登録", NOTE].join("\n"),
		);
		expect(response.data.components[0].components[0].label).toBe(
			"sigwキーを登録",
		);
	});

	it("ボタンを押すと、キーを入れる画面を開く", async () => {
		const user = await newUser();
		expect(await sendInteraction(registerButton(user))).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "sigw:modal",
				title: "sigwキーの登録",
				components: [
					{
						type: ComponentType.Label,
						label: "sigwキー",
						description: "sigwのWeb UIで発行したキー(sgk_…)",
						component: {
							type: ComponentType.TextInput,
							custom_id: "key",
							style: 1,
							required: true,
							max_length: 200,
						},
					},
				],
			},
		});
	});
});

describe("/sigw の登録", () => {
	it("sigwが受け付けたキーを、暗号化して保存し、呼べるプロバイダを知らせる", async () => {
		const user = await newUser();
		const environment = sigwEnv({
			[TEST_SIGW_KEY]: ALL_SIGW_PROVIDERS,
			[NEW_KEY]: ["anthropic", "openrouter"],
		});
		expect(await sendInteraction(submit(user, NEW_KEY), environment)).toEqual(
			ephemeral(
				"sigwキーを登録しました。呼べるプロバイダ: Anthropic、OpenRouter",
			),
		);

		const row = await env.DB.prepare(
			"SELECT ciphertext, last4, providers, registered_by, registered_at FROM sigw_key",
		).first<Record<string, unknown>>();
		expect(row?.ciphertext).not.toContain(NEW_KEY);
		expect(row).toMatchObject({
			last4: "wxyz",
			providers: JSON.stringify(["anthropic", "openrouter"]),
			registered_by: user.id,
		});
		expect(row?.registered_at).toEqual(expect.any(Number));
		expect((await loadSigwKey(env))?.key).toBe(NEW_KEY);

		// この後の呼び出しは、新しいキーで行い、TypeSafe(Jev)は呼べない
		expect(await jevAvailable(environment)).toBe(false);
		const calls = mockFetch(() => Response.json({}));
		await sigwOpenRouterFetch(
			{ env: environment, userId: user.id },
			"/chat/completions",
			{ method: "POST", body: "{}" },
		);
		expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${NEW_KEY}`);

		// 画面も、新しいキーで見せる
		const panel = await sendInteraction(command(user), environment);
		expect(panel.data.content).toContain("登録済み(末尾 wxyz)");
		expect(panel.data.content).toContain(
			"- 呼べるプロバイダ: Anthropic、OpenRouter\n",
		);
	});

	it("問い合わせでは、キーと登録する人をsigwに送る", async () => {
		const user = await newUser();
		const seen: Request[] = [];
		const environment = sigwEnv(
			{},
			{
				keyInfo: (request) => {
					seen.push(request);
					return Response.json({ last4: "wxyz", providers: ["typesafe"] });
				},
			},
		);
		await sendInteraction(submit(user, NEW_KEY), environment);
		expect(seen[0]?.headers.get("x-api-key")).toBe(NEW_KEY);
		expect(seen[0]?.headers.get("x-sigw-user")).toBe(user.id);
	});

	it("全角の文字や空白、見えない文字が混ざっていても、整えて登録する", async () => {
		const user = await newUser();
		const environment = sigwEnv({ [NEW_KEY]: ["anthropic"] });
		const typed = ` ｓｇｋ＿ｎｅｗｋｅｙ0000000​wxyz\n`;
		expect(await sendInteraction(submit(user, typed), environment)).toEqual(
			ephemeral("sigwキーを登録しました。呼べるプロバイダ: Anthropic"),
		);
		expect((await loadSigwKey(env))?.key).toBe(NEW_KEY);
	});

	it("sgk_ で始まらないキーは、sigwに問い合わせずに断る", async () => {
		const user = await newUser();
		const keyInfo = vi.fn(() => Response.json({}));
		const environment = sigwEnv({}, { keyInfo });
		for (const key of ["sk-ant-api03-abc", "sgk_", "sgk_あいう"]) {
			expect(await sendInteraction(submit(user, key), environment)).toEqual(
				ephemeral(MALFORMED),
			);
		}
		expect(keyInfo).not.toHaveBeenCalled();
		expect((await loadSigwKey(env))?.key).toBe(TEST_SIGW_KEY);
	});

	it("sigwが断ったキーは保存せず、sigwの文を見せる", async () => {
		const user = await newUser();
		expect(await sendInteraction(submit(user, NEW_KEY), sigwEnv())).toEqual(
			ephemeral(
				`sigwがこのキーを受け付けませんでした。${REJECTED_KEY_MESSAGE}`,
			),
		);
		expect((await loadSigwKey(env))?.key).toBe(TEST_SIGW_KEY);
	});

	it("sigwに問い合わせられなければ、保存しない", async () => {
		const user = await newUser();
		const environment = sigwEnv(
			{},
			{ keyInfo: () => new Response("unavailable", { status: 503 }) },
		);
		expect(await sendInteraction(submit(user, NEW_KEY), environment)).toEqual(
			ephemeral(
				"sigwにキーを確かめられませんでした。少し待ってから、もう一度試してください。",
			),
		);
		expect((await loadSigwKey(env))?.key).toBe(TEST_SIGW_KEY);
	});
});

describe("呼べるプロバイダ", () => {
	it("登録したキーで、sigwに問い合わせて決める", async () => {
		const environment = sigwEnv({ [TEST_SIGW_KEY]: ["anthropic", "typesafe"] });
		expect([...(await sigwProviders(environment))]).toEqual(["anthropic"]);
		expect(await jevAvailable(environment)).toBe(true);
	});

	it("キーを登録していなければ、どれも呼べない", async () => {
		await env.DB.prepare("DELETE FROM sigw_key").run();
		const state = await sigwState(sigwEnv());
		expect(state.key).toBeNull();
		expect(state.providers.size).toBe(0);
	});

	it("sigwがキーを断ったら、どれも呼べない", async () => {
		const state = await sigwState(sigwEnv({}));
		expect(state.key).toBe(TEST_SIGW_KEY);
		expect(state.providers.size).toBe(0);
	});

	it("問い合わせた結果を1分覚えておき、過ぎたら問い合わせ直す", async () => {
		const keyInfo = vi.fn(() =>
			Response.json({ last4: "abcd", providers: ["openrouter"] }),
		);
		const environment = sigwEnv({}, { keyInfo });
		const now = 1_000_000;
		await sigwState(environment, now);
		await sigwState(environment, now + 59_000);
		expect(keyInfo).toHaveBeenCalledTimes(1);
		await sigwState(environment, now + 60_000);
		expect(keyInfo).toHaveBeenCalledTimes(2);
	});

	it("sigwに問い合わせられなければ、前の結果で続け、少し後に問い合わせ直す", async () => {
		let available = true;
		const keyInfo = vi.fn(() =>
			available
				? Response.json({ last4: "abcd", providers: ["openrouter"] })
				: new Response("unavailable", { status: 503 }),
		);
		const environment = sigwEnv({}, { keyInfo });
		const now = 1_000_000;
		await sigwState(environment, now);
		available = false;
		const fallback = await sigwState(environment, now + 60_000);
		expect([...fallback.providers]).toEqual(["openrouter"]);
		// 10秒は前の結果で続け、過ぎたら問い合わせ直す
		await sigwState(environment, now + 69_000);
		expect(keyInfo).toHaveBeenCalledTimes(2);
		await sigwState(environment, now + 70_000);
		expect(keyInfo).toHaveBeenCalledTimes(3);
	});

	it("前の結果もなければ、登録したときの結果で続ける", async () => {
		await saveSigwKey(env, {
			key: TEST_SIGW_KEY,
			last4: "abcd",
			providers: ["anthropic"],
			registeredBy: "0",
			registeredAt: 0,
		});
		const environment = sigwEnv(
			{},
			{
				keyInfo: () => {
					throw new Error("network");
				},
			},
		);
		expect([...(await sigwProviders(environment))]).toEqual(["anthropic"]);
	});
});
