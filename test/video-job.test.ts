import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoJobRequest } from "../src/video/job-object";
import {
	claimVideoJob,
	getVideoJob,
	getVideoResources,
	videoJobStub,
} from "../src/video/store";
import { BOT, CHANNEL_ID, discordMessage } from "./fixtures";
import { type FetchCall, mockFetch, userFactory } from "./helpers";

const newUser = userFactory(63000);
const GUILD_ID = "900";

afterEach(() => {
	vi.restoreAllMocks();
});

function request(userId: string, requestedAt = Date.now()): VideoJobRequest {
	return {
		userId,
		guildId: GUILD_ID,
		channelId: CHANNEL_ID,
		messageId: "5000",
		speaker: { name: "ずんだもん", styleId: 3 },
		file: {
			kind: "conversation",
			version: 1,
			facts: {
				participants: 2,
				messages: 3,
				firstMessageAt: "2026-11-16T09:00:00+09:00",
				lastMessageAt: "2026-11-16T09:02:00+09:00",
			},
			script: {
				title: "リリース日の相談",
				headline: "来週のリリースの相談",
				opening: { narration: ["会話をまとめたのだ。"] },
				scenes: [],
				closing: { narration: ["以上なのだ。"] },
			},
		},
		requestedAt,
	};
}

/** 動画の仕事を受けさせる(D1の記録も作る) */
async function startedJob(userId: string, requestedAt = Date.now()) {
	await claimVideoJob(
		env.DB,
		{
			userId,
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			messageId: "5000",
			createdAt: requestedAt,
		},
		0,
	);
	const stub = videoJobStub(env, userId);
	expect(await stub.start(request(userId, requestedAt))).toBe(true);
	return stub;
}

/**
 * 予約したアラームを動かし、終わるまで待つ。start はすぐにアラームを予約するので、
 * 自然に動いたアラームと重なることがある。どちらでも、次の見回り(30秒後)が予約されるか、記録が消えるまで待つ
 */
async function settled(stub: ReturnType<typeof videoJobStub>, userId: string) {
	await runDurableObjectAlarm(stub);
	await vi.waitFor(async () => {
		const alarm = await runInDurableObject(stub, (_, state) =>
			state.storage.getAlarm(),
		);
		const job = await getVideoJob(env.DB, userId);
		expect(job === null || (alarm ?? 0) > Date.now() + 1_000).toBe(true);
	});
}

interface FakeSession {
	status: string;
	events: Record<string, unknown>[];
	outputs: Record<string, unknown>[];
}

/** Managed AgentsとDiscordのAPIの偽物 */
function mockApis(session: FakeSession) {
	return mockFetch((call: FetchCall) => {
		const path = call.url.pathname;
		if (call.url.hostname === "api.anthropic.com") {
			if (path === "/v1/agents" && call.method === "POST") {
				return Response.json({ id: "agent_v", type: "agent", version: 1 });
			}
			if (path === "/v1/environments" && call.method === "POST") {
				return Response.json({ id: "env_v", type: "environment" });
			}
			if (path === "/v1/files" && call.method === "POST") {
				return Response.json({
					id: "file_up",
					type: "file",
					filename: "conversation.json",
				});
			}
			if (path === "/v1/files" && call.method === "GET") {
				return Response.json({
					data: session.outputs,
					has_more: false,
					first_id: null,
					last_id: null,
				});
			}
			if (path === "/v1/files/file_mp4/content") {
				return new Response(new Uint8Array([1, 2, 3]), {
					headers: { "Content-Type": "video/mp4" },
				});
			}
			if (path === "/v1/sessions" && call.method === "POST") {
				return Response.json({
					id: "sesn_v",
					type: "session",
					status: "idle",
					resources: [{ id: "sesrsc_1", type: "file", file_id: "file_copy" }],
				});
			}
			if (path === "/v1/sessions/sesn_v/events" && call.method === "GET") {
				return Response.json({ data: session.events, next_page: null });
			}
			if (path === "/v1/sessions/sesn_v/events" && call.method === "POST") {
				return Response.json({ data: [] });
			}
			if (path === "/v1/sessions/sesn_v" && call.method === "GET") {
				return Response.json({
					id: "sesn_v",
					type: "session",
					status: session.status,
				});
			}
			return Response.json({ id: "deleted", type: "deleted" });
		}
		if (call.url.pathname === `/api/v10/guilds/${GUILD_ID}`) {
			return Response.json({ id: GUILD_ID, premium_tier: 0 });
		}
		if (call.method === "POST" && path.endsWith("/messages")) {
			return Response.json(discordMessage("m1", BOT, ""));
		}
		return new Response(null, { status: 204 });
	});
}

function posted(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
		)
		.map(
			(call) =>
				call.body as {
					content: string;
					message_reference: { message_id: string };
					files?: { name: string }[];
				},
		);
}

function anthropicCalls(calls: FetchCall[], method: string, path: string) {
	return calls.filter(
		(call) =>
			call.url.hostname === "api.anthropic.com" &&
			call.method === method &&
			call.url.pathname === path,
	);
}

describe("動画の仕事のDurable Object", () => {
	it("1人1本まで。仕事があれば、次は受けない", async () => {
		const owner = await newUser();
		mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);

		expect(await stub.start(request(owner.id))).toBe(false);
		await settled(stub, owner.id);
	});

	it("動画用のエージェントと環境を作ってセッションを始め、台本をファイルで置いて、手順を送る", async () => {
		// 本人のキーは要らない。sigw経由で、頼んだ人の費用として呼ぶ
		const owner = await newUser();
		const calls = mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);

		await settled(stub, owner.id);

		expect(await getVideoResources(env.DB, owner.id)).toEqual({
			agentId: "agent_v",
			environmentId: "env_v",
		});
		const environment = anthropicCalls(calls, "POST", "/v1/environments")[0];
		expect(environment?.body).toMatchObject({
			config: {
				networking: { type: "limited", allow_package_managers: true },
			},
		});
		const created = anthropicCalls(calls, "POST", "/v1/sessions")[0];
		expect(created?.body).toMatchObject({
			agent: { model: { id: "claude-haiku-5-5", effort: "low" } },
			resources: [
				{
					type: "file",
					file_id: "file_up",
					mount_path: "/video/conversation.json",
				},
			],
		});
		// 台本は手順に入れず、ファイルとして置く
		const sent = anthropicCalls(calls, "POST", "/v1/sessions/sesn_v/events")[0];
		const text = JSON.stringify(sent?.body);
		expect(text).toContain("--speaker 3");
		expect(text).not.toContain("リリース日の相談");
		// セッション用の写しができたので、上げた元のファイルは消す
		expect(anthropicCalls(calls, "DELETE", "/v1/files/file_up")).toHaveLength(
			1,
		);
		expect(posted(calls)).toEqual([]);
		// どの呼び出しも、Bobert用のsigwのキーで、頼んだ人のIDを付けて呼ぶ
		const managed = calls.filter(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(managed.length).toBeGreaterThan(0);
		for (const call of managed) {
			expect(call.headers.get("x-api-key")).toBe("sgk-anthropic-test");
			expect(call.headers.get("x-sigw-user")).toBe(owner.id);
		}
	});

	it("動画ができたら、頼んだメッセージへの返信として投稿し、セッションと記録を消す", async () => {
		const owner = await newUser();
		mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);
		await settled(stub, owner.id);
		vi.restoreAllMocks();
		const calls = mockApis({
			status: "idle",
			events: [
				{ id: "e1", type: "user.message", content: [] },
				{
					id: "e2",
					type: "agent.message",
					content: [{ type: "text", text: "できました" }],
				},
				{
					id: "e3",
					type: "session.status_idle",
					stop_reason: { type: "end_turn" },
				},
			],
			outputs: [
				{
					id: "file_mp4",
					type: "file",
					filename: "summary.mp4",
					mime_type: "video/mp4",
					size_bytes: 1_400_000,
					created_at: "2026-11-16T01:00:00Z",
					downloadable: true,
				},
			],
		});

		await runDurableObjectAlarm(stub);

		const messages = posted(calls);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			content:
				"動画ができました。\n-# AIが会話を要約して作りました。音声: VOICEVOX:ずんだもん",
			message_reference: { message_id: "5000" },
			files: [{ name: "summary.mp4" }],
		});
		expect(anthropicCalls(calls, "DELETE", "/v1/sessions/sesn_v")).toHaveLength(
			1,
		);
		expect(anthropicCalls(calls, "DELETE", "/v1/files/file_mp4")).toHaveLength(
			1,
		);
		expect(await getVideoJob(env.DB, owner.id)).toBeNull();
		// 記録を消したので、次の仕事を受けられる
		expect(await stub.start(request(owner.id))).toBe(true);
	});

	it("動画が10MBを超えて止まったら、大きさを知らせる", async () => {
		const owner = await newUser();
		mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);
		await settled(stub, owner.id);
		vi.restoreAllMocks();
		const calls = mockApis({
			status: "idle",
			events: [
				{ id: "e1", type: "user.message", content: [] },
				{
					id: "e2",
					type: "agent.message",
					content: [
						{
							type: "text",
							text: "render が失敗しました: 動画の大きさが 12.3MB あり、上限の 10.0MB を超えています",
						},
					],
				},
				{
					id: "e3",
					type: "session.status_idle",
					stop_reason: { type: "end_turn" },
				},
			],
			outputs: [],
		});

		await runDurableObjectAlarm(stub);

		expect(posted(calls).map((message) => message.content)).toEqual([
			"動画が12.3MBあり、Discordに投稿できる10MBを超えたので、投稿できませんでした。対象の会話を短くして、もう一度頼んでください。",
		]);
		expect(await getVideoJob(env.DB, owner.id)).toBeNull();
	});

	it("動画がなく、理由も分からなければ、失敗を知らせる", async () => {
		const owner = await newUser();
		mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);
		await settled(stub, owner.id);
		vi.restoreAllMocks();
		const calls = mockApis({
			status: "idle",
			events: [
				{ id: "e1", type: "user.message", content: [] },
				{
					id: "e3",
					type: "session.status_idle",
					stop_reason: { type: "end_turn" },
				},
			],
			outputs: [],
		});

		await runDurableObjectAlarm(stub);

		expect(posted(calls).map((message) => message.content)).toEqual([
			"動画を作れませんでした。少し待ってから、もう一度頼んでください。",
		]);
	});

	it("手順を送る前の止まった状態は、終わったとみなさない", async () => {
		const owner = await newUser();
		mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);
		await settled(stub, owner.id);
		vi.restoreAllMocks();
		const calls = mockApis({
			status: "idle",
			events: [
				{
					id: "e0",
					type: "session.status_idle",
					stop_reason: { type: "end_turn" },
				},
				{ id: "e1", type: "user.message", content: [] },
			],
			outputs: [],
		});

		await runDurableObjectAlarm(stub);

		expect(posted(calls)).toEqual([]);
		expect(await getVideoJob(env.DB, owner.id)).not.toBeNull();
	});

	it("15分たってもできなければ、セッションを消して知らせる", async () => {
		const owner = await newUser();
		const calls = mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id, Date.now() - 16 * 60 * 1000);

		await settled(stub, owner.id);

		expect(posted(calls).map((message) => message.content)).toEqual([
			"15分たっても動画ができなかったので、作るのをやめました。もう一度頼んでください。",
		]);
		expect(await getVideoJob(env.DB, owner.id)).toBeNull();
	});

	it("/delete で消すときは、知らせを出さずに記録を消す", async () => {
		const owner = await newUser();
		const calls = mockApis({ status: "running", events: [], outputs: [] });
		const stub = await startedJob(owner.id);

		await stub.purge();

		expect(posted(calls)).toEqual([]);
		expect(await getVideoJob(env.DB, owner.id)).toBeNull();
	});
});
