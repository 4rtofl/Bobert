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

describe("prepare_video のリンク先のページ", () => {
	/** URLごとに決めた応答を返す、偽物の取得。取得したURLを記録する */
	function fakeFetch(pages: Record<string, Response | Error>) {
		const fetched: string[] = [];
		const fetcher = async (url: string) => {
			fetched.push(url);
			const page = pages[url];
			if (page === undefined || page instanceof Error) {
				throw page ?? new Error("not found");
			}
			return page;
		};
		return { fetched, fetcher };
	}

	function html(body: string): Response {
		return new Response(body, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	it("発言に貼られたURLの先のページを読んで、本文を添える。読めなかったページは理由を書き、断らないよう伝える", async () => {
		const shared = said(
			0,
			BOB,
			"この記事おもしろい https://example.com/article",
			{
				embeds: [
					{
						type: "link" as never,
						url: "https://example.com/article",
						title: "新しい研究の話",
						description: "研究チームは…",
					},
				],
			},
		);
		const broken = said(1, ALICE, "こっちは? <https://example.org/missing>");
		const trigger = said(2, ALICE, "<@0> これを動画にして");
		const { fetched, fetcher } = fakeFetch({
			"https://example.com/article": html(
				"<html><head><title>新しい研究の話</title></head><body><nav>メニュー</nav><article><h1>新しい研究の話</h1><p>研究チームは、睡眠と記憶の関係を調べた。</p></article></body></html>",
			),
			"https://example.org/missing": new Response("no", { status: 404 }),
		});
		const material = newVideoMaterial();
		const tool = prepareVideoTool(
			fakeHistory([shared, broken, trigger]),
			BOT.id,
			requesterFor(trigger),
			material,
			fetcher,
		);

		const result = await tool.run({});

		expect(fetched.sort()).toEqual([
			"https://example.com/article",
			"https://example.org/missing",
		]);
		expect(result).toContain("## リンク先のページ");
		expect(result).toContain("### https://example.com/article");
		expect(result).toContain("タイトル: 新しい研究の話");
		expect(result).toContain("研究チームは、睡眠と記憶の関係を調べた。");
		// <article>があれば、その外(メニューなど)は入れない
		expect(result).not.toContain("メニュー");
		expect(result).toContain(
			"- https://example.org/missing: 読めませんでした(HTTP 404)",
		);
		expect(result).toContain("動画を作るのをやめないでください。");
		// ページは発言として数えない
		expect(material.messages.size).toBe(2);
	});

	it("URLがなければ、ページの節を添えない", async () => {
		const trigger = said(3, ALICE, "<@0> これを動画にして");
		const { fetched, fetcher } = fakeFetch({});
		const result = await prepareVideoTool(
			fakeHistory([...CONVERSATION, trigger]),
			BOT.id,
			requesterFor(trigger),
			newVideoMaterial(),
			fetcher,
		).run({});

		expect(fetched).toEqual([]);
		expect(result).not.toContain("## リンク先のページ");
	});

	it("1回の返答で読むページは10件まで。新しい発言のURLから読み、同じURLは2度読まない", async () => {
		const links = Array.from({ length: 12 }, (_, i) =>
			said(i, BOB, `https://example.com/${i} と https://example.com/${i}`),
		);
		const trigger = said(20, ALICE, "<@0> これを動画にして");
		const pages = Object.fromEntries(
			links.map((_, i) => [
				`https://example.com/${i}`,
				html(`<p>ページ${i}</p>`),
			]),
		);
		const { fetched, fetcher } = fakeFetch(pages);
		const result = await prepareVideoTool(
			fakeHistory([...links, trigger]),
			BOT.id,
			requesterFor(trigger),
			newVideoMaterial(),
			fetcher,
		).run({});

		expect(fetched).toHaveLength(10);
		expect(fetched).not.toContain("https://example.com/0");
		expect(fetched).not.toContain("https://example.com/1");
		expect(result).toContain(
			"- https://example.com/1: 1回の返答で読めるページ(10件)を超えたので、読んでいません",
		);
	});

	it("リンク先のページの文は、引用に使えない", async () => {
		const shared = said(0, BOB, "https://example.com/article");
		const trigger = said(1, ALICE, "<@0> これを動画にして", {
			author: { ...ALICE, id: "3101" },
		});
		const material = newVideoMaterial();
		const requester = requesterFor(trigger, "3101");
		await prepareVideoTool(
			fakeHistory([shared, trigger]),
			BOT.id,
			requester,
			material,
			fakeFetch({
				"https://example.com/article": html(
					"<p>テストが終わってから決めよう</p>",
				),
			}).fetcher,
		).run({});
		const starter = recordingStarter();

		const result = await createVideoTool(
			env.DB,
			requester,
			material,
			starter.start,
		).run({ script: script("テストが終わってから決めよう", "bob") });

		expect(result).toContain("scenes[1].text");
		expect(starter.started).toEqual([]);
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

		const result = await tool.run({ script: script(), speaker: "四国めたん" });

		expect(result).toContain("動画を作り始めました。");
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
