import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { parseConversationFile } from "dopagakix/conversation";
import { describe, expect, it } from "vitest";
import { fromDiscord, type HistoryDeps } from "../src/respond/history";
import type { VideoJobRequest } from "../src/video/job-object";
import { videoInstructions } from "../src/video/sandbox";
import {
	DEFAULT_SPEAKER,
	findSpeaker,
	VIDEO_SPEAKERS,
} from "../src/video/speakers";
import { getVideoJob } from "../src/video/store";
import {
	createVideoTool,
	jstIso,
	newVideoMaterial,
	prepareVideoTool,
	type VideoMaterial,
	type VideoRequester,
} from "../src/video/tools";
import { ALICE, BOB, BOT, CHANNEL_ID, discordMessage } from "./fixtures";

const GUILD_ID = "900";
const DISCORD_EPOCH = 1420070400000n;
/** テストの発言の時刻の起点(2026-11-16 09:00 日本時間) */
const BASE = Date.parse("2026-11-16T00:00:00.000Z");

/** その時刻に投稿されたメッセージのID */
function snowflake(ms: number): string {
	return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}

/** minutes分後に投稿された発言 */
function said(
	minutes: number,
	author: typeof ALICE,
	content: string,
	extra: Partial<APIMessage> = {},
): APIMessage {
	const ms = BASE + minutes * 60_000;
	return discordMessage(snowflake(ms), author, content, {
		timestamp: new Date(ms).toISOString(),
		...extra,
	});
}

/** 偽物のDiscord。チャンネルにmessagesがあることにし、一覧はDiscordと同じく新しい順で返す */
function fakeHistory(messages: APIMessage[]): HistoryDeps {
	const byId = new Map(messages.map((message) => [message.id, message]));
	return {
		db: env.DB,
		guildId: GUILD_ID,
		channelId: CHANNEL_ID,
		fetchMessage: async (_channelId, messageId) => byId.get(messageId) ?? null,
		listMessages: async (_channelId, { before, after, limit }) => {
			const sorted = [...messages].sort((a, b) =>
				BigInt(a.id) < BigInt(b.id) ? 1 : -1,
			);
			if (after !== undefined) {
				return sorted
					.filter((message) => BigInt(message.id) > BigInt(after))
					.slice(-limit);
			}
			return sorted
				.filter(
					(message) =>
						before === undefined || BigInt(message.id) < BigInt(before),
				)
				.slice(0, limit);
		},
		searchMessages: async () => [],
		ingest: async () => {},
		knownNames: [],
	};
}

function requesterFor(trigger: APIMessage, userId = ALICE.id): VideoRequester {
	return { userId, guildId: GUILD_ID, trigger: fromDiscord(trigger, GUILD_ID) };
}

/** 確かめが通る台本。引用は、quoteTextを使う */
function script(quoteText = "テストが終わってから決めよう", by = "Alice") {
	return {
		title: "リリース日の相談",
		headline: "来週のリリースを予定どおり出すかの相談",
		opening: { narration: ["来週のリリースについての会話をまとめたのだ。"] },
		scenes: [
			{
				type: "topic",
				heading: "リリース日",
				lines: ["来週の金曜に出す予定"],
				narration: ["話題は、来週のリリースの日程なのだ。"],
			},
			{
				type: "quote",
				text: quoteText,
				by,
				narration: ["アリスさんは、テストを待つよう言ったのだ。"],
			},
			{
				type: "outcome",
				decided: ["テストの後に決める"],
				open: ["告知の文面"],
				narration: ["テストが終わってから決めることになったのだ。"],
			},
		],
		closing: { narration: ["以上、会話のまとめだったのだ。"] },
	};
}

/** script() を、です・ます調の読み上げ文にした台本(ずんだもん以外の話者に使う) */
function politeScript(quoteText?: string, by?: string) {
	const base = script(quoteText, by);
	const polite = (lines: string[]) =>
		lines.map((line) =>
			line
				.replace(/(?:なの|の)だ。$/, "です。")
				.replace(/したです。$/, "しました。"),
		);
	return {
		...base,
		opening: { narration: polite(base.opening.narration) },
		scenes: base.scenes.map((scene) => ({
			...scene,
			narration: polite(scene.narration),
		})),
		closing: { narration: polite(base.closing.narration) },
	};
}

/** 動画の仕事を始めた記録 */
function recordingStarter(result = true) {
	const started: VideoJobRequest[] = [];
	return {
		started,
		start: async (request: VideoJobRequest) => {
			started.push(request);
			return result;
		},
	};
}

const CONVERSATION = [
	said(0, BOB, "来週のリリース、予定どおり金曜でいい?"),
	said(1, ALICE, "うーん、テストが終わってから決めよう。"),
	said(2, BOB, "了解。告知の文面はまだ決めてない"),
];

describe("prepare_video", () => {
	it("返信せずに頼んだときは、頼んだメッセージの直前の会話を渡し、台本の書き方を添える", async () => {
		const trigger = said(3, ALICE, "<@0> これを動画にして");
		const history = fakeHistory([...CONVERSATION, trigger]);
		const material = newVideoMaterial();
		const tool = prepareVideoTool(
			history,
			BOT.id,
			requesterFor(trigger),
			material,
		);

		const result = await tool.run({});

		expect(result).toContain("このチャンネルの発言です(古い順、3件)");
		expect(result).toContain("来週のリリース、予定どおり金曜でいい?");
		// 頼んだメッセージそのものは入れない
		expect(result).not.toContain("これを動画にして");
		expect(result).toContain("これより前の発言はありません。");
		expect(result).toContain("## 動画の台本の書き方");
		// 話者の口調は読み上げ文だけ。返答には使わせない
		expect(result).toContain(
			"利用者への返答は、話者の口調ではなく、いつもの口調で書きます。",
		);
		expect([...material.messages.keys()]).toEqual(
			CONVERSATION.map((message) => message.id),
		);
	});

	it("返信しながら頼んだときは、返信先までと、その後の発言を少し渡す", async () => {
		const later = said(10, BOB, "ところで昼ごはんどうする?");
		const trigger = said(11, ALICE, "<@0> これを動画にして", {
			message_reference: {
				message_id: CONVERSATION[1]?.id,
				channel_id: CHANNEL_ID,
			},
		});
		const history = fakeHistory([...CONVERSATION, later, trigger]);
		const material = newVideoMaterial();

		await prepareVideoTool(
			history,
			BOT.id,
			requesterFor(trigger),
			material,
		).run({});

		expect([...material.messages.keys()]).toEqual([
			CONVERSATION[0]?.id,
			CONVERSATION[1]?.id,
			CONVERSATION[2]?.id,
			later.id,
		]);
	});

	it("足りなければ、more で、もっと前の発言を読める", async () => {
		const many = Array.from({ length: 45 }, (_, i) =>
			said(i, i % 2 === 0 ? ALICE : BOB, `発言${i}`),
		);
		const trigger = said(50, ALICE, "<@0> 動画にして");
		const history = fakeHistory([...many, trigger]);
		const material = newVideoMaterial();
		const tool = prepareVideoTool(
			history,
			BOT.id,
			requesterFor(trigger),
			material,
		);

		const first = await tool.run({});
		expect(first).toContain("古い順、40件");
		expect(first).toContain("これより前にも発言があります。");

		const second = await tool.run({ more: true });
		expect(second).toContain("古い順、5件");
		expect(second).toContain("発言0");
		expect(second).not.toContain("## 動画の台本の書き方");
		expect(material.messages.size).toBe(45);

		expect(await tool.run({ more: true })).toBe(
			"これより前の発言はありません。読んだ発言で動画を作ってください。",
		);
	});
});

describe("create_video", () => {
	/** 会話を読んだところまで進めた、道具と記録 */
	async function prepared(userId: string) {
		const trigger = said(3, ALICE, "<@0> これを動画にして", {
			author: { ...ALICE, id: userId },
		});
		const history = fakeHistory([...CONVERSATION, trigger]);
		const material: VideoMaterial = newVideoMaterial();
		const requester = requesterFor(trigger, userId);
		await prepareVideoTool(history, BOT.id, requester, material).run({});
		return { trigger, material, requester };
	}

	it("先に会話を読んでいなければ、作らない", async () => {
		const trigger = said(3, ALICE, "動画にして");
		const starter = recordingStarter();
		const tool = createVideoTool(
			env.DB,
			requesterFor(trigger, "3001"),
			newVideoMaterial(),
			starter.start,
		);

		expect(await tool.run({ script: script() })).toBe(
			"先に prepare_video で会話を読んでください。",
		);
		expect(starter.started).toEqual([]);
	});

	it("台本の形が正しくなければ、誤りを返して直させる", async () => {
		const { material, requester } = await prepared("3002");
		const starter = recordingStarter();
		const tool = createVideoTool(env.DB, requester, material, starter.start);

		const result = await tool.run({ script: { title: "題" } });

		expect(result).toContain("台本の形が正しくありません。");
		expect(starter.started).toEqual([]);
	});

	it("引用が読んだ発言の本文になければ、作らない。名前の食い違いも返す", async () => {
		const { material, requester } = await prepared("3003");
		const starter = recordingStarter();
		const tool = createVideoTool(env.DB, requester, material, starter.start);

		const paraphrased = await tool.run({
			script: script("テストの後で決めましょう"),
		});
		expect(paraphrased).toContain("scenes[1].text");

		const wrongName = await tool.run({
			script: script("テストが終わってから決めよう", "Bob"),
		});
		expect(wrongName).toContain("scenes[1].by");
		expect(starter.started).toEqual([]);
	});

	it("台本の警告は2回まで返して直させ、3回目は警告が残っていても作る", async () => {
		const { material, requester } = await prepared("3004");
		const starter = recordingStarter();
		const tool = createVideoTool(env.DB, requester, material, starter.start);
		const withWarning = {
			...script(),
			headline: "来週のリリースを予定どおり出すかを話し合ったのだ",
		};

		expect(await tool.run({ script: withWarning })).toContain("headline");
		expect(await tool.run({ script: withWarning })).toContain("headline");
		expect(await tool.run({ script: withWarning })).toContain(
			"動画を作り始めました。",
		);
		expect(starter.started).toHaveLength(1);
	});

	it("確かめが通ったら、Bobertが数えた数値を付けて、動画の仕事を始める", async () => {
		const { trigger, material, requester } = await prepared("3005");
		const starter = recordingStarter();
		const tool = createVideoTool(
			env.DB,
			requester,
			material,
			starter.start,
			() => 1_000,
		);

		const result = await tool.run({
			script: politeScript(),
			speaker: "四国めたん",
		});

		expect(result).toContain("動画を作り始めました。");
		// 返答には、読み上げ文の口調を使わせない
		expect(result).toContain(
			"返答は、台本の読み上げ文の口調ではなく、いつもの口調で書いてください。",
		);
		const request = starter.started[0];
		expect(request).toMatchObject({
			userId: "3005",
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			messageId: trigger.id,
			speaker: { name: "四国めたん", styleId: 2 },
			requestedAt: 1_000,
		});
		expect(request?.file.facts).toEqual({
			participants: 2,
			messages: 3,
			firstMessageAt: "2026-11-16T09:00:00+09:00",
			lastMessageAt: "2026-11-16T09:02:00+09:00",
		});
		expect(parseConversationFile(request?.file).success).toBe(true);
		expect(await getVideoJob(env.DB, "3005")).toMatchObject({
			messageId: trigger.id,
		});
		// 同じ返答の中で、もう1本は作らない
		expect(await tool.run({ script: script() })).toBe(
			"動画は、この返答の中ですでに作り始めています。",
		);
	});

	it("作っている途中の動画があれば、断る(1人1本まで)", async () => {
		const first = await prepared("3006");
		await createVideoTool(
			env.DB,
			first.requester,
			first.material,
			recordingStarter().start,
		).run({ script: script() });
		const second = await prepared("3006");
		const starter = recordingStarter();

		const result = await createVideoTool(
			env.DB,
			second.requester,
			second.material,
			starter.start,
		).run({ script: script() });

		expect(result).toContain("いま別に作っています");
		expect(starter.started).toEqual([]);
	});

	it("ずんだもん以外の話者で、読み上げ文が「〜のだ」口調なら、です・ます調に直させる", async () => {
		const { material, requester } = await prepared("3008");
		const starter = recordingStarter();
		const tool = createVideoTool(env.DB, requester, material, starter.start);

		const result = await tool.run({ script: script(), speaker: "四国めたん" });

		expect(result).toContain("台本に直したほうがよい点があります。");
		expect(result).toContain("opening.narration[0]");
		expect(result).toContain("です・ます調");
		expect(starter.started).toEqual([]);

		expect(
			await tool.run({ script: politeScript(), speaker: "四国めたん" }),
		).toContain("動画を作り始めました。");
		expect(starter.started).toHaveLength(1);
	});

	it("選べない話者は断る", async () => {
		const { material, requester } = await prepared("3007");
		const tool = createVideoTool(
			env.DB,
			requester,
			material,
			recordingStarter().start,
		);

		expect(await tool.run({ script: script(), speaker: "青山龍星" })).toContain(
			"speaker には、次のどれかを指定してください",
		);
	});
});

describe("話者", () => {
	it("既定はずんだもん。利用規約で条件の付いた話者は選べない", () => {
		expect(DEFAULT_SPEAKER).toEqual({ name: "ずんだもん", styleId: 3 });
		for (const name of [
			"青山龍星",
			"もち子さん",
			"後鬼",
			"Voidoll",
			"ぞん子",
			"No.7",
			"ユーレイちゃん",
		]) {
			expect(findSpeaker(name)).toBeNull();
		}
		expect(new Set(VIDEO_SPEAKERS.map((speaker) => speaker.styleId)).size).toBe(
			VIDEO_SPEAKERS.length,
		);
	});
});

describe("サンドボックスへの手順", () => {
	it("話者のIDで check と render を実行し、動画だけを出力のフォルダーに置く", () => {
		const text = videoInstructions(2);

		expect(text).toContain(
			"dopagakix check /tmp/dopagakix/conversation.json --json --speaker 2",
		);
		expect(text).toContain(
			"-o /mnt/session/outputs/summary.mp4 --work-dir /tmp/dopagakix",
		);
		expect(text).toContain("/mnt/session/uploads/video/conversation.json");
	});
});

describe("jstIso", () => {
	it("日本時間のISO 8601にする", () => {
		expect(jstIso(Date.parse("2026-11-16T15:30:00.000Z"))).toBe(
			"2026-11-17T00:30:00+09:00",
		);
	});
});
