import { DurableObject } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationFile } from "dopagakix/conversation";
import { agentClient, deleteSession, isSessionGone } from "../agent/managed";
import { discordUploadLimit, MAX_ATTACHMENT_BYTES } from "../agent/relay";
import { formatMegabytes } from "../agent/texts";
import { createMessage, getGuild } from "../discord/api";
import { type AnthropicCredential, toLlmError } from "../llm/anthropic";
import { LlmError } from "../llm/types";
import { logEvent } from "../log";
import { describeLlmError } from "../respond/replies";
import { loadCredential } from "../store/users";
import {
	checkVideoSession,
	deleteVideoOutputs,
	startVideoSession,
	VIDEO_AGENT_MODEL,
	type VideoOutput,
} from "./sandbox";
import { deleteVideoJob } from "./store";
import {
	VIDEO_FAILED,
	VIDEO_TIMED_OUT,
	videoReadyMessage,
	videoTooLargeMessage,
} from "./texts";

/** 動画ができるまで待つ長さ。過ぎたら、セッションを止めて消し、頼んだ人に知らせる */
export const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
/** セッションの様子を確かめる間隔 */
const POLL_MS = 30_000;
/** 様子を確かめられなかったときに、やり直す間隔 */
const RETRY_MS = 60_000;

/** 動画の仕事の中身。create_video の道具が渡す */
export interface VideoJobRequest {
	userId: string;
	guildId: string;
	channelId: string;
	/** 動画を頼んだメッセージ(できた動画は、これへの返信として投稿する) */
	messageId: string;
	speaker: { name: string; styleId: number };
	/** dopagakix に渡すファイル(台本と、Bobertが数えた数値) */
	file: ConversationFile;
	/** 頼まれた時刻 */
	requestedAt: number;
}

interface VideoJobState extends VideoJobRequest {
	/** Managed Agentsのセッション。始める前はnull */
	sessionId: string | null;
	/** 上げた台本のファイル。セッションを消すときに一緒に消す */
	uploadedFileId: string | null;
}

/** 仕事を終えるときの知らせの種類 */
type Ending =
	| { kind: "done"; output: VideoOutput }
	| { kind: "too_large"; size: string; limit: string }
	| { kind: "timeout" }
	| { kind: "failed"; text: string };

/**
 * 動画の仕事のDurable Object(利用者ごとに1つ。仕様: docs/spec/architecture.md「動画の作成」)。
 * 本人のAnthropicのアカウントでサンドボックスのセッションを始め、アラームで様子を見回る。
 * 動画ができたら、頼んだメッセージへの返信として投稿し、セッションとファイルを消す。
 * デプロイなどで止まっても、保存したセッションのIDで、次のアラームから続ける
 */
export class VideoJob extends DurableObject<Env> {
	private chain: Promise<unknown> = Promise.resolve();

	/** 仕事を受ける。もう別の仕事があればfalse(1人1本まで) */
	async start(request: VideoJobRequest): Promise<boolean> {
		return this.serial(async () => {
			if ((await this.loadState()) !== null) {
				return false;
			}
			await this.saveState({
				...request,
				sessionId: null,
				uploadedFileId: null,
			});
			// セッションを始めるのは、アラームで行う(返答を待たせないため)
			await this.ctx.storage.setAlarm(Date.now());
			return true;
		});
	}

	/** /delete。セッションを消し、記録を消す。知らせは出さない。本人のキーはD1から先に消すので、呼び出し元から受け取る */
	async purge(credential: AnthropicCredential | null): Promise<void> {
		await this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return;
			}
			if (credential !== null) {
				await this.cleanUp(agentClient(credential), state);
			}
			await this.clear(state);
		});
	}

	override async alarm(): Promise<void> {
		await this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return;
			}
			const credential = await loadCredential(
				this.env,
				state.userId,
				"anthropic",
			);
			if (credential === null) {
				// キーが消された(/delete)。セッションは /delete が消すので、記録だけを消す。知らせは出さない
				this.log("credential_missing", state);
				await this.clear(state);
				return;
			}
			const client = agentClient(credential);
			if (Date.now() >= state.requestedAt + VIDEO_TIMEOUT_MS) {
				this.log("timed_out", state);
				await this.finish(client, state, { kind: "timeout" });
				return;
			}
			if (state.sessionId === null) {
				await this.begin(client, state);
				return;
			}
			await this.watch(client, state, state.sessionId);
		});
	}

	/** セッションを始める。始められなければ、理由を知らせて終える */
	private async begin(client: Anthropic, state: VideoJobState): Promise<void> {
		try {
			const started = await startVideoSession(
				this.env.DB,
				state.userId,
				client,
				state.file,
				state.speaker.styleId,
			);
			state.sessionId = started.sessionId;
			state.uploadedFileId = started.uploadedFileId;
			await this.saveState(state);
			this.log("started", state);
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		} catch (error) {
			this.log("start_failed", state, error);
			await this.finish(client, state, {
				kind: "failed",
				text: failureText(error),
			});
		}
	}

	/** セッションの様子を確かめ、終わっていれば、動画を投稿するか、失敗を知らせる */
	private async watch(
		client: Anthropic,
		state: VideoJobState,
		sessionId: string,
	): Promise<void> {
		let progress: Awaited<ReturnType<typeof checkVideoSession>>;
		try {
			progress = await checkVideoSession(client, sessionId);
		} catch (error) {
			if (isSessionGone(error)) {
				this.log("session_gone", state);
				await this.finish(client, state, {
					kind: "failed",
					text: VIDEO_FAILED,
				});
				return;
			}
			this.log("check_failed", state, error);
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
			return;
		}
		switch (progress.kind) {
			case "working":
				await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
				return;
			case "done": {
				const limit = await this.uploadLimit(state.guildId);
				if (progress.file.sizeBytes > limit) {
					await this.finish(client, state, {
						kind: "too_large",
						size: formatMegabytes(progress.file.sizeBytes),
						limit: formatMegabytes(limit),
					});
					return;
				}
				await this.finish(client, state, {
					kind: "done",
					output: progress.file,
				});
				return;
			}
			case "too_large":
				await this.finish(client, state, {
					kind: "too_large",
					size: `${progress.sizeMb}MB`,
					limit: "10MB",
				});
				return;
			case "insufficient_credit":
				await this.finish(client, state, {
					kind: "failed",
					text: creditText(),
				});
				return;
			case "failed":
				this.log("failed", state, progress.reason);
				await this.finish(client, state, {
					kind: "failed",
					text: VIDEO_FAILED,
				});
				return;
		}
	}

	/**
	 * 仕事を終える。動画ができていれば投稿し、できていなければ理由を知らせる。
	 * セッションと、上げたファイルと出したファイルを消し、記録を消す
	 */
	private async finish(
		client: Anthropic,
		state: VideoJobState,
		ending: Ending,
	): Promise<void> {
		try {
			if (ending.kind === "done") {
				await this.postVideo(client, state, ending.output);
			} else {
				await this.notify(state, endingText(ending));
			}
		} catch (error) {
			this.log("notify_failed", state, error);
		}
		await this.cleanUp(client, state);
		await this.clear(state);
		logEvent("video", "finished", {
			userId: state.userId,
			guildId: state.guildId,
			result: ending.kind,
			speaker: state.speaker.name,
			durationMs: Date.now() - state.requestedAt,
		});
	}

	/** 動画を取り出し、頼んだメッセージへの返信として投稿する。投稿できなければ、失敗を知らせる */
	private async postVideo(
		client: Anthropic,
		state: VideoJobState,
		output: VideoOutput,
	): Promise<void> {
		const response = await client.files.download(output.id);
		const content = new Uint8Array(await response.arrayBuffer());
		try {
			await createMessage(
				this.env.DISCORD_BOT_TOKEN,
				state.channelId,
				{
					content: videoReadyMessage(state.speaker.name),
					message_reference: {
						message_id: state.messageId,
						fail_if_not_exists: false,
					},
					allowed_mentions: { parse: [], replied_user: true },
				},
				[{ name: "summary.mp4", content, contentType: "video/mp4" }],
			);
		} catch (error) {
			this.log("post_failed", state, error);
			await this.notify(state, VIDEO_FAILED);
		}
	}

	/** 頼んだメッセージへの返信として知らせる */
	private async notify(state: VideoJobState, text: string): Promise<void> {
		await createMessage(this.env.DISCORD_BOT_TOKEN, state.channelId, {
			content: text,
			message_reference: {
				message_id: state.messageId,
				fail_if_not_exists: false,
			},
			allowed_mentions: { parse: [], replied_user: true },
		});
	}

	/** セッションと、上げたファイルと出したファイルを消す。消せなくても続ける */
	private async cleanUp(
		client: Anthropic,
		state: VideoJobState,
	): Promise<void> {
		if (state.sessionId !== null) {
			await deleteVideoOutputs(client, state.sessionId);
			await deleteSession(client, state.sessionId).catch((error: unknown) => {
				this.log("session_cleanup_failed", state, error);
			});
		}
		if (state.uploadedFileId !== null) {
			await client.files.delete(state.uploadedFileId).catch(() => {});
		}
	}

	private async clear(state: VideoJobState): Promise<void> {
		await deleteVideoJob(this.env.DB, state.userId);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/**
	 * このサーバーで、動画を出せる大きさ。Discordに上げられる大きさ(サーバーのブーストの段階で決まる)と、
	 * Workersで扱える大きさ(25MB)の、小さい方
	 */
	private async uploadLimit(guildId: string): Promise<number> {
		const tier = await getGuild(this.env.DISCORD_BOT_TOKEN, guildId)
			.then((guild) => guild.premium_tier)
			.catch(() => 0);
		return Math.min(discordUploadLimit(tier), MAX_ATTACHMENT_BYTES);
	}

	private async loadState(): Promise<VideoJobState | null> {
		return (await this.ctx.storage.get<VideoJobState>("state")) ?? null;
	}

	private async saveState(state: VideoJobState): Promise<void> {
		await this.ctx.storage.put("state", state);
	}

	/** 状態を読み書きする処理を、1つずつ順番に動かす(アラームと /delete が混ざらないように) */
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work);
		this.chain = next.catch(() => {});
		return next;
	}

	private log(event: string, state: VideoJobState, error?: unknown): void {
		logEvent("video", event, {
			userId: state.userId,
			guildId: state.guildId,
			sessionId: state.sessionId,
			...(error === undefined
				? {}
				: {
						error: error instanceof Error ? error.message : String(error),
					}),
		});
	}
}

/** 知らせる文 */
function endingText(ending: Exclude<Ending, { kind: "done" }>): string {
	switch (ending.kind) {
		case "too_large":
			return videoTooLargeMessage(ending.size, ending.limit);
		case "timeout":
			return VIDEO_TIMED_OUT;
		case "failed":
			return ending.text;
	}
}

/** Anthropicの残高が足りないときの文(返答のエラーと同じ文) */
function creditText(): string {
	return describeLlmError(
		new LlmError("insufficient_credit", null, "billing_error"),
		{
			provider: "anthropic",
			modelId: VIDEO_AGENT_MODEL,
			label: VIDEO_AGENT_MODEL,
			supportsImages: false,
			supportsPdf: false,
		},
	);
}

/** セッションを始められなかったときの文。残高が足りなければ、そう伝える。ほかは、失敗の文にする */
function failureText(error: unknown): string {
	return toLlmError(error).kind === "insufficient_credit"
		? creditText()
		: VIDEO_FAILED;
}
