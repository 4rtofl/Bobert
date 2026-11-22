import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionType } from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { JEV_SYSTEM_PROMPT } from "../src/jev/prompt";
import {
	JEV_COMMAND_NO_TOOLS,
	JEV_ERROR,
	JEV_NO_QUESTION,
} from "../src/jev/texts";
import { parseAsk } from "../src/jev/tool";
import { clearModelInfoCache } from "../src/llm/model-info";
import { AI_UNAVAILABLE_TEXT } from "../src/llm/sigw";
import type {
	JevJob,
	QueueMessage,
	StoredMessageInput,
} from "../src/queue/messages";
import { fromDiscord } from "../src/respond/history";
import { handleJevJob } from "../src/respond/jev";
import { RATE_LIMITED_TEXT } from "../src/respond/replies";
import { updateUserSettings } from "../src/store/users";
import {
	ALICE,
	at,
	BOB,
	CHANNEL_ID,
	discordMessage,
	discordReply,
} from "./fixtures";
import {
	anthropicStreamOf,
	type FetchCall,
	guildInteraction,
	mockFetch,
	noSigwEnv,
	openRouterOnlyEnv,
	sendInteraction,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

const GUILD_ID = "900";
/** 頼まれた時刻(日本時間で2026-10-28(水) 10:00) */
const REQUESTED_AT = Date.parse("2026-10-28T01:00:00.000Z");

/** BobertにTypeSafe用のsigwのキーがない環境(Jevを呼び出せない) */
function noTypeSafeEnv(base: Env): Env {
	return { ...base, SIGW_TYPESAFE_KEY: "" };
}

/** 応答用のQueueの偽物。入れた仕事を記録する */
function fakeQueues() {
	const sent: QueueMessage[] = [];
	const queue = {
		send: async (body: QueueMessage) => {
			sent.push(body);
		},
		sendBatch: async () => {},
	} as unknown as Queue;
	const environment: Env = {
		...env,
		INGEST_QUEUE: queue,
		RESPOND_QUEUE: queue,
	};
	return { environment, sent };
}

/** Jevに聞く人(このファイルのユーザーIDは65000番台) */
function userOf(id: string) {
	return { ...BOB, id };
}

/**
 * Discord、AI、TypeSafeのAPIの偽物。Discordにはmessagesがあることにする。
 * 保留にした応答を書き換えたら、9960のメッセージになる。新しく投稿したメッセージには、9961から続くIDを付ける
 */
function mockApis(
	messages: APIMessage[],
	apis: {
		ai: (call: FetchCall) => Response;
		jev?: (call: FetchCall) => Response;
	},
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let nextId = 9961;
	return mockFetch((call) => {
		if (call.url.hostname === "api.typesafe.ai") {
			return apis.jev?.(call) ?? new Response(null, { status: 500 });
		}
		if (call.url.hostname !== "discord.com") {
			return apis.ai(call);
		}
		const path = call.url.pathname.replace("/api/v10", "");
		const read = path.match(/^\/channels\/\d+\/messages\/(\d+)$/);
		if (call.method === "GET" && read) {
			const message = stored.get(read[1] ?? "");
			return message
				? Response.json(message)
				: Response.json({ code: 10008 }, { status: 404 });
		}
		if (call.method === "PATCH" && path.endsWith("/messages/@original")) {
			return Response.json({ id: "9960", channel_id: CHANNEL_ID });
		}
		if (call.method === "POST" && path === `/channels/${CHANNEL_ID}/messages`) {
			return Response.json({ id: String(nextId++), channel_id: CHANNEL_ID });
		}
		return new Response(null, { status: 500 });
	});
}

interface AnthropicRequest {
	system: { text: string }[];
	messages: {
		role: string;
		content: {
			type: string;
			text?: string;
			content?: string;
			tool_use_id?: string;
		}[];
	}[];
	tools?: { name: string }[];
}

/** Anthropicに送ったリクエスト */
function anthropicRequests(calls: FetchCall[]): AnthropicRequest[] {
	return calls
		.filter((call) => call.url.hostname === "api.anthropic.com")
		.map((call) => call.body as AnthropicRequest);
}

/** TypeSafe(Jev)に送ったリクエスト */
function jevCalls(calls: FetchCall[]): FetchCall[] {
	return calls.filter((call) => call.url.hostname === "api.typesafe.ai");
}

/** 投稿した結果(保留にした応答の書き換え) */
function postedResult(calls: FetchCall[]) {
	return calls.find((call) => call.method === "PATCH")?.body as
		| { content: string; allowed_mentions: unknown }
		| undefined;
}

/** AIが「Jevに聞く」の道具を呼んだ応答(Anthropic) */
function askJev(input: unknown, id = "toolu_jev") {
	return anthropicStreamOf(
		[
			{ type: "text", text: "調べてから聞きます" },
			{ type: "tool_use", id, name: "ask_jev", input },
		],
		{ stopReason: "tool_use" },
	);
}

/** Jevの成功の応答 */
function jevAnswered(answers: Record<string, unknown>): Response {
	return Response.json({
		model: "jev-1.14.0",
		answers,
		usage: { input_tokens: 300, output_tokens: 20 },
	});
}

/** はい/いいえの質問1つの入力 */
const NOUL_INPUT = {
	meaning: "Alice asks whether Osaka is the capital of Japan.",
	context: "",
	questions: [
		{
			type: "noul",
			question: "Is Osaka the capital of Japan?",
			display_question: "日本の首都は大阪である",
			yes: "Osaka is the capital of Japan.",
			no: "Osaka is not the capital of Japan.",
		},
	],
};

function jevJob(
	user: { id: string },
	target: APIMessage,
	interactionId: string,
): JevJob {
	return {
		kind: "jev",
		interactionId,
		interactionToken: "interaction-token",
		userId: user.id,
		userName: "ぼぶ",
		channelId: CHANNEL_ID,
		guildId: GUILD_ID,
		target: fromDiscord(target, GUILD_ID),
		requestedAt: REQUESTED_AT,
	};
}

/** `/jev`を使ったInteraction */
function commandInteraction(user: { id: string }, question: string) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{
			id: "20",
			name: "jev",
			type: 1,
			options: [{ type: 3, name: "question", value: question }],
		},
		{ ...BOB, id: user.id },
	);
}

/** `/jev`の仕事。対象は、入力された「聞くこと」を、使った人の発言にしたもの */
function commandJob(
	user: { id: string },
	question: string,
	interactionId: string,
): JevJob {
	const target: StoredMessageInput = {
		messageId: `jev-command:${interactionId}`,
		guildId: GUILD_ID,
		channelId: CHANNEL_ID,
		authorId: user.id,
		authorName: "ぼぶ",
		authorIsBot: false,
		content: question,
		replyToId: null,
		mentions: [],
		attachments: [],
		embeds: [],
		command: null,
		members: [],
		createdAt: REQUESTED_AT,
		editedAt: null,
	};
	return {
		kind: "jev",
		source: "command",
		interactionId,
		interactionToken: "interaction-token",
		userId: user.id,
		userName: "ぼぶ",
		channelId: CHANNEL_ID,
		guildId: GUILD_ID,
		target,
		requestedAt: REQUESTED_AT,
	};
}

/** 右クリックメニューで「Jevに聞く」を選んだInteraction */
function menuInteraction(user: { id: string }, target: APIMessage) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{
			id: "19",
			name: "Jevに聞く",
			type: 3,
			target_id: target.id,
			resolved: { messages: { [target.id]: target } },
		},
		{ ...BOB, id: user.id },
	);
}

describe("右クリックメニューの「Jevに聞く」", () => {
	it("右クリックメニューに「Jevに聞く」を登録し、/helpにも書く", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({ type: 3, name: "Jevに聞く" }),
		);
		expect(helpText()).toContain(
			"- メッセージの右クリックメニュー(アプリ)の「Jevに聞く」: AIがメッセージと前後の会話を読んで質問を作り、Jevが確率で答えます",
		);
	});

	it("AIとJevを呼び出せれば、チャンネルに見える保留の応答を返し、仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const user = userOf("65001");
		const target = discordMessage("65100", ALICE, "日本の首都は大阪だよね?");

		const body = await sendInteraction(
			menuInteraction(user, target),
			environment,
		);

		// 保留の応答は、本人だけでなくチャンネルに見える(flagsを付けない)
		expect(body).toEqual({ type: 5 });
		expect(sent).toEqual([
			{
				kind: "jev",
				source: "menu",
				interactionId: "1",
				interactionToken: "interaction-token",
				userId: user.id,
				userName: "bob",
				channelId: CHANNEL_ID,
				guildId: GUILD_ID,
				target: fromDiscord(target, GUILD_ID),
				requestedAt: expect.any(Number),
			},
		]);
	});

	it("BobertにTypeSafe用のsigwのキーがなければ、呼び出せないことを本人にだけ見せ、仕事は入れない", async () => {
		const { environment, sent } = fakeQueues();
		const user = userOf("65002");
		const target = discordMessage("65101", ALICE, "おはよう");

		const body = await sendInteraction(
			menuInteraction(user, target),
			noTypeSafeEnv(environment),
		);

		expect(body).toEqual({
			type: 4,
			data: { content: AI_UNAVAILABLE_TEXT, flags: 64 },
		});
		expect(sent).toEqual([]);
	});

	it("Bobertにsigwのキーがなければ、AIを呼び出せないことを本人にだけ見せる", async () => {
		const { environment, sent } = fakeQueues();
		const user = userOf("65003");
		const target = discordMessage("65102", ALICE, "おはよう");

		const body = await sendInteraction(
			menuInteraction(user, target),
			noSigwEnv(environment),
		);

		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("Bobertの管理者");
		expect(sent).toEqual([]);
	});
});

describe("「Jevに聞く」の仕事", () => {
	it("AIが作った質問でJevに聞き、AIには結果を返さずに、Jevの回答を投稿する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65010");
		const target = discordMessage("65110", ALICE, "日本の首都は大阪だよね?");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.03 } }),
		});

		await handleJevJob(jevJob(user, target, "65111"), environment);

		// Jevが答えたら、AIとのやり取りを終える(結果をAIに返して、続きを頼まない)
		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.system.map((block) => block.text)).toEqual([
			JEV_SYSTEM_PROMPT,
		]);
		expect(request?.messages).toEqual([
			{
				role: "user",
				content: [
					expect.objectContaining({
						text: at("Alice: 日本の首都は大阪だよね?"),
					}),
				],
			},
			{
				role: "user",
				content: [
					expect.objectContaining({
						text: "[2026-10-28(水) 10:00] ぼぶ: 上のメッセージについて、Jevに聞いて",
					}),
				],
			},
		]);
		// 文脈を調べる道具と、Jevに聞く道具を渡す(メンバーを探す道具は渡さない)
		expect(request?.tools?.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_pinned_messages",
			"read_file",
			"ask_jev",
		]);

		// sigw経由で、TypeSafe用のsigwのキーで呼び、費用を払う人(選んだ人)を伝える
		const [jev] = jevCalls(calls);
		expect(jev?.method).toBe("POST");
		expect(jev?.url.href).toBe("https://api.typesafe.ai/v1/systemone");
		expect(jev?.headers.get("Authorization")).toBe(
			`Bearer ${env.SIGW_TYPESAFE_KEY}`,
		);
		expect(jev?.headers.get("x-sigw-user")).toBe(user.id);
		expect(jev?.body).toEqual({
			model: "jev-latest",
			state: {
				message: { author: "Alice", text: "日本の首都は大阪だよね?" },
				meaning: "Alice asks whether Osaka is the capital of Japan.",
			},
			questions: {
				q1: {
					type: "noul",
					instructions: "Is Osaka the capital of Japan?",
					criteria: {
						true: "Osaka is the capital of Japan.",
						false: "Osaka is not the capital of Japan.",
					},
				},
			},
		});

		expect(postedResult(calls)).toEqual({
			content: "**Jevの回答**: 日本の首都は大阪である\nはい 3%・**いいえ 97%**",
			allowed_mentions: { parse: [] },
		});
		// 結果に返信して会話を続けられるよう、結果と対象のメッセージの対応を保存する
		const saved = await env.DB.prepare(
			"SELECT target_message_id FROM explain_targets WHERE response_message_id = ?",
		)
			.bind("9960")
			.first<string>("target_message_id");
		expect(saved).toBe("65110");
	});

	it("選択肢は確率の高い順に、段階は低い順に並べ、いちばん高いものを太字にする", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65011");
		const target = discordMessage(
			"65120",
			ALICE,
			"週末どこに集まる?あと、この計画いけそう?",
		);
		const calls = mockApis([], {
			ai: () =>
				askJev({
					meaning: "Alice asks where to meet and whether the plan is feasible.",
					context: "They plan a meetup this Saturday. Rain is forecast.",
					questions: [
						{
							type: "choice",
							question: "Which place suits the weekend meetup best?",
							display_question: "週末の集まりに合う場所はどれか",
							options: [
								{ label: "公園", description: "The park" },
								{
									label: "駅前のカフェ",
									description: "The cafe by the station",
								},
								{ label: "誰かの家", description: "Someone's home" },
							],
						},
						{
							type: "score",
							question: "How feasible is the plan?",
							display_question: "この計画の実現しやすさ",
							levels: [
								{ label: "とても難しい", description: "Very hard" },
								{ label: "難しい", description: "Hard" },
								{ label: "ふつう", description: "Moderate" },
								{ label: "やりやすい", description: "Easy" },
								{ label: "すぐできる", description: "Trivial" },
							],
						},
					],
				}),
			jev: () =>
				jevAnswered({
					q1: {
						type: "choice",
						choice: "B",
						confidence: 0.52,
						probabilities: { A: 0.28, B: 0.64, C: 0.08 },
					},
					q2: {
						type: "score",
						score: 2.63,
						confidence: 0.6,
						probabilities: { 0: 0.01, 1: 0.09, 2: 0.3, 3: 0.5, 4: 0.1 },
						legend: {
							0: "Very hard",
							1: "Hard",
							2: "Moderate",
							3: "Easy",
							4: "Trivial",
						},
					},
				}),
		});

		await handleJevJob(jevJob(user, target, "65121"), environment);

		// 選択肢の名前はA、B、…にして、説明で判断してもらう。文脈があれば、stateに入れる
		expect(jevCalls(calls)[0]?.body).toMatchObject({
			state: {
				context: "They plan a meetup this Saturday. Rain is forecast.",
			},
			questions: {
				q1: {
					type: "choice",
					instructions: "Which place suits the weekend meetup best?",
					criteria: {
						A: "The park",
						B: "The cafe by the station",
						C: "Someone's home",
					},
				},
				q2: {
					type: "score",
					instructions: "How feasible is the plan?",
					criteria: ["Very hard", "Hard", "Moderate", "Easy", "Trivial"],
				},
			},
		});
		expect(postedResult(calls)?.content).toBe(
			[
				"**Jevの回答**: 週末の集まりに合う場所はどれか",
				"- **駅前のカフェ 64%**",
				"- 公園 28%",
				"- 誰かの家 8%",
				"",
				"**Jevの回答**: この計画の実現しやすさ",
				"スコア 2.6(0〜4)",
				"- 0 とても難しい 1%",
				"- 1 難しい 9%",
				"- 2 ふつう 30%",
				"- **3 やりやすい 50%**",
				"- 4 すぐできる 10%",
			].join("\n"),
		);
	});

	it("対象のメッセージが返信なら、返信先を読む道具も渡す", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65012");
		const parent = discordMessage("65130", BOB, "明日の集まり、来る?");
		const target = discordReply("65131", ALICE, "たぶん", parent);
		const calls = mockApis([parent], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.5 } }),
		});

		await handleJevJob(jevJob(user, target, "65132"), environment);

		expect(
			anthropicRequests(calls)[0]?.tools?.map((tool) => tool.name),
		).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_pinned_messages",
			"read_file",
			"read_reply_chain",
			"ask_jev",
		]);
		// 確率が同じなら、どちらも太字にしない
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\nはい 50%・いいえ 50%",
		);
	});

	it("入力が正しくなければ、Jevを呼ばずに理由をAIに返し、直した入力で聞く", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65013");
		const target = discordMessage("65140", ALICE, "どれがいい?");
		let round = 0;
		const calls = mockApis([], {
			ai: () => {
				round++;
				return round === 1
					? askJev(
							{
								meaning: "Alice asks which is best.",
								context: "",
								questions: [
									{
										type: "choice",
										question: "Which is best?",
										display_question: "どれがいいか",
									},
								],
							},
							"toolu_1",
						)
					: askJev(NOUL_INPUT, "toolu_2");
			},
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.9 } }),
		});

		await handleJevJob(jevJob(user, target, "65141"), environment);

		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(2);
		const toolResult = requests[1]?.messages.at(-1)?.content[0];
		expect(toolResult).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content:
				"入力が正しくありません。直して、もう一度呼んでください。\n- questions[0].optionsには、2〜10個書いてください。",
		});
		expect(jevCalls(calls)).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\n**はい 90%**・いいえ 10%",
		);
	});

	it("Jevがリクエストを受け付けなければ、理由をAIに返して直してもらう", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65014");
		const target = discordMessage("65150", ALICE, "本当?");
		let round = 0;
		const calls = mockApis([], {
			ai: () => {
				round++;
				return askJev(NOUL_INPUT, `toolu_${round}`);
			},
			jev: () =>
				jevCalls(calls).length === 1
					? Response.json(
							{
								detail: [
									{
										loc: ["body", "questions", "q1", "instructions"],
										msg: "String should have at most 500 characters",
										type: "string_too_long",
									},
								],
							},
							{ status: 422 },
						)
					: jevAnswered({ q1: { type: "noul", noul: 0.2 } }),
		});

		await handleJevJob(jevJob(user, target, "65151"), environment);

		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content:
				"Jevがリクエストを受け付けませんでした(ステータス 422)。直して、もう一度呼んでください。\nbody.questions.q1.instructions: String should have at most 500 characters",
		});
		expect(jevCalls(calls)).toHaveLength(2);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\nはい 20%・**いいえ 80%**",
		);
	});

	it.each([
		{ status: 401, text: AI_UNAVAILABLE_TEXT, userId: "65021" },
		{ status: 429, text: RATE_LIMITED_TEXT, userId: "65022" },
		{ status: 529, text: JEV_ERROR, userId: "65023" },
	])(
		// $statusの直後に日本語を続けると、名前の一部として読まれるので、かぎ括弧で区切る
		"Jevの呼び出しが「$status」で失敗したら、AIに続きを頼まずに理由を投稿する",
		async ({ status, text, userId }) => {
			const { environment } = fakeQueues();
			const user = userOf(userId);
			const target = discordMessage("65160", ALICE, "本当?");
			const calls = mockApis([], {
				ai: () => askJev(NOUL_INPUT),
				jev: () => Response.json({ detail: "error" }, { status }),
			});

			await handleJevJob(jevJob(user, target, `6516${status}`), environment);

			expect(anthropicRequests(calls)).toHaveLength(1);
			expect(postedResult(calls)?.content).toBe(text);
		},
	);

	it("同じ回に2回呼ばれても、直せない失敗の後は、もうJevを呼ばない", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65024");
		const target = discordMessage("65165", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				anthropicStreamOf(
					[
						{
							type: "tool_use",
							id: "toolu_a",
							name: "ask_jev",
							input: NOUL_INPUT,
						},
						{
							type: "tool_use",
							id: "toolu_b",
							name: "ask_jev",
							input: NOUL_INPUT,
						},
					],
					{ stopReason: "tool_use" },
				),
			jev: () => Response.json({ detail: "invalid key" }, { status: 401 }),
		});

		await handleJevJob(jevJob(user, target, "65166"), environment);

		expect(jevCalls(calls)).toHaveLength(1);
		expect(anthropicRequests(calls)).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(AI_UNAVAILABLE_TEXT);
	});

	it.each([
		{ status: 400, userId: "65025" },
		{ status: 402, userId: "65026" },
	])(
		"sigw自身が「$status」で断ったら、AIに直させずに、sigwの文を理由として投稿する",
		async ({ status, userId }) => {
			const { environment } = fakeQueues();
			const user = userOf(userId);
			const target = discordMessage("65167", ALICE, "本当?");
			const sigwText = "[sigw] 今月の上限額に達しました";
			const calls = mockApis([], {
				ai: () => askJev(NOUL_INPUT),
				jev: () => Response.json({ detail: sigwText }, { status }),
			});

			await handleJevJob(jevJob(user, target, `6516${status}`), environment);

			expect(jevCalls(calls)).toHaveLength(1);
			expect(anthropicRequests(calls)).toHaveLength(1);
			expect(postedResult(calls)?.content).toBe(sigwText);
		},
	);

	it("AIがJevに聞かずに終えたら、質問を作れなかったと投稿する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65030");
		const target = discordMessage("65170", ALICE, "おはよう");
		const calls = mockApis([], {
			ai: () => anthropicStreamOf([{ type: "text", text: "挨拶だね" }]),
		});

		await handleJevJob(jevJob(user, target, "65171"), environment);

		expect(jevCalls(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(JEV_NO_QUESTION);
	});

	it("選んだ後にTypeSafe用のsigwのキーが外されていたら、AIを呼ばずに、呼び出せないことを投稿する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65031");
		const target = discordMessage("65180", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
		});

		await handleJevJob(
			jevJob(user, target, "65181"),
			noTypeSafeEnv(environment),
		);

		expect(anthropicRequests(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(AI_UNAVAILABLE_TEXT);
	});

	it("同じ仕事は2回投稿しない", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65032");
		const target = discordMessage("65190", ALICE, "本当?");
		const job = jevJob(user, target, "65191");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.7 } }),
		});

		await handleJevJob(job, environment);
		await handleJevJob(job, environment);

		expect(jevCalls(calls)).toHaveLength(1);
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
	});

	it("OpenRouterのモデルでも、Jevが答えたらAIとのやり取りを終える", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65033");
		const target = discordMessage("65200", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				Response.json({
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "ask_jev",
											arguments: JSON.stringify(NOUL_INPUT),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
				}),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.6 } }),
		});

		await handleJevJob(
			jevJob(user, target, "65201"),
			openRouterOnlyEnv(environment),
		);

		expect(
			calls.filter((call) => call.url.hostname === "openrouter.ai"),
		).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\n**はい 60%**・いいえ 40%",
		);
	});
});

describe("/jev", () => {
	it("聞くことの入力欄を付けて登録し、/helpのコマンドの一覧にも出す", () => {
		const description =
			"Jev(TypeSafeの判定モデル)に聞く。AIが会話を読んで質問を作り、Jevが確率で答える";
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				type: 1,
				name: "jev",
				description,
				options: [
					{
						type: 3,
						name: "question",
						description: "Jevに聞くこと(例: 明日の集まりは雨で中止になりそう?)",
						required: true,
						min_length: 1,
						max_length: 1000,
					},
				],
			}),
		);
		expect(helpText()).toContain(`- \`/jev\`: ${description}`);
	});

	it("AIとJevを呼び出せれば、チャンネルに見える保留の応答を返し、入力を対象のメッセージにした仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const user = userOf("65060");

		const body = await sendInteraction(
			commandInteraction(user, "  明日の集まりは雨で中止になりそう?  "),
			environment,
		);

		// 右クリックメニューと同じく、チャンネルに見える保留の応答にする(flagsを付けない)
		expect(body).toEqual({ type: 5 });
		expect(sent).toEqual([
			{
				kind: "jev",
				source: "command",
				interactionId: "1",
				interactionToken: "interaction-token",
				userId: user.id,
				userName: "bob",
				channelId: CHANNEL_ID,
				guildId: GUILD_ID,
				target: {
					// Discordにはないメッセージなので、ほかと重ならないIDにする。前後の空白は除く
					messageId: "jev-command:1",
					guildId: GUILD_ID,
					channelId: CHANNEL_ID,
					authorId: user.id,
					authorName: "bob",
					authorIsBot: false,
					content: "明日の集まりは雨で中止になりそう?",
					replyToId: null,
					mentions: [],
					attachments: [],
					embeds: [],
					command: null,
					members: [],
					createdAt: expect.any(Number),
					editedAt: null,
				},
				requestedAt: expect.any(Number),
			},
		]);
	});

	it("BobertにTypeSafe用のsigwのキーがなければ、呼び出せないことを本人にだけ見せ、仕事は入れない", async () => {
		const { environment, sent } = fakeQueues();
		const user = userOf("65061");

		const body = await sendInteraction(
			commandInteraction(user, "本当?"),
			noTypeSafeEnv(environment),
		);

		expect(body).toEqual({
			type: 4,
			data: { content: AI_UNAVAILABLE_TEXT, flags: 64 },
		});
		expect(sent).toEqual([]);
	});

	it("入力された聞くことを対象のメッセージにして、右クリックメニューと同じ渡し方でJevに聞く", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65062");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.03 } }),
		});

		await handleJevJob(
			commandJob(user, "日本の首都って大阪?", "65300"),
			environment,
		);

		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.system.map((block) => block.text)).toEqual([
			JEV_SYSTEM_PROMPT,
		]);
		expect(
			requests[0]?.messages.map((message) => message.content[0]?.text),
		).toEqual([
			"[2026-10-28(水) 10:00] ぼぶ: 日本の首都って大阪?",
			"[2026-10-28(水) 10:00] ぼぶ: 上のメッセージについて、Jevに聞いて",
		]);
		expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_pinned_messages",
			"read_file",
			"ask_jev",
		]);
		expect(jevCalls(calls)[0]?.body).toMatchObject({
			state: { message: { author: "ぼぶ", text: "日本の首都って大阪?" } },
		});
		expect(postedResult(calls)).toEqual({
			content: "**Jevの回答**: 日本の首都は大阪である\nはい 3%・**いいえ 97%**",
			allowed_mentions: { parse: [] },
		});
		// 対象はDiscordにはないメッセージなので、結果との対応は残さない
		const saved = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM explain_targets WHERE target_message_id = ?",
		)
			.bind("jev-command:65300")
			.first<number>("count");
		expect(saved).toBe(0);
	});

	it("使った後にTypeSafe用のsigwのキーが外されていたら、AIを呼ばずに、呼び出せないことを投稿する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65063");
		const calls = mockApis([], { ai: () => askJev(NOUL_INPUT) });

		await handleJevJob(
			commandJob(user, "本当?", "65301"),
			noTypeSafeEnv(environment),
		);

		expect(anthropicRequests(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(AI_UNAVAILABLE_TEXT);
	});

	it("道具を使えないモデルでは、/jevを使えないと投稿する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65064");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "x-ai/old-model",
		});
		const calls = mockApis([], {
			ai: (call) =>
				call.url.pathname === "/api/v1/models"
					? Response.json({
							data: [
								{ id: "x-ai/old-model", supported_parameters: ["max_tokens"] },
							],
						})
					: new Response(null, { status: 500 }),
		});

		await handleJevJob(commandJob(user, "本当?", "65302"), environment);

		expect(jevCalls(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(JEV_COMMAND_NO_TOOLS);
	});
});

describe("「Jevに聞く」の道具の入力", () => {
	it("表示する文の改行は空白にし、Markdownの記号はそのまま表示する", async () => {
		const { environment } = fakeQueues();
		const user = userOf("65040");
		const target = discordMessage("65210", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				askJev({
					...NOUL_INPUT,
					questions: [
						{
							...NOUL_INPUT.questions[0],
							display_question: "**太字**の\n質問",
						},
					],
				}),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.7 } }),
		});

		await handleJevJob(jevJob(user, target, "65211"), environment);

		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: \\*\\*太字\\*\\*の 質問\n**はい 70%**・いいえ 30%",
		);
	});

	it("質問の数、型、選択肢の名前の重なりを確かめる", () => {
		const result = parseAsk({
			meaning: "m",
			context: "",
			questions: [
				{ type: "noul", question: "q", display_question: "d", yes: "y" },
				{
					type: "choice",
					question: "q",
					display_question: "d",
					options: [
						{ label: "同じ", description: "a" },
						{ label: "同じ", description: "b" },
					],
				},
				{ type: "box", question: "q", display_question: "d" },
			],
		});

		expect(result).toEqual({
			ok: false,
			problems: [
				"questions[0].noを、文で書いてください。",
				"questions[1].optionsのlabelは、それぞれ違う名前にしてください。",
				"questions[2].typeは、noul、choice、scoreのどれかにしてください。",
			],
		});
		expect(
			parseAsk({ meaning: "m", context: "", questions: [] }),
		).toMatchObject({
			ok: false,
			problems: ["questionsには、質問を1〜3個書いてください。"],
		});
	});
});

describe("TypeSafeのキーの登録をなくした後", () => {
	it("登録したTypeSafeのキーを保存していた表を消す", async () => {
		const table = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'typesafe_credentials'",
		).first();
		expect(table).toBeNull();
	});
});
