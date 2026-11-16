import type { AgentResources } from "../agent/store";

/**
 * 動画の作成の記録(D1)。仕様: docs/spec/architecture.md「動画の作成」
 * - video_users: 利用者ごとに、本人のAnthropicのアカウントに作った、動画用のエージェントの設定と環境
 * - video_jobs: 作っている途中の動画(1人1本まで)
 */

/** 作っている途中の動画 */
export interface VideoJobRecord {
	userId: string;
	guildId: string;
	channelId: string;
	/** 動画を頼んだメッセージ */
	messageId: string;
	createdAt: number;
}

export async function getVideoResources(
	db: D1Database,
	userId: string,
): Promise<AgentResources | null> {
	const row = await db
		.prepare(
			"SELECT agent_id, environment_id FROM video_users WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ agent_id: string; environment_id: string }>();
	return row === null
		? null
		: { agentId: row.agent_id, environmentId: row.environment_id };
}

export async function saveVideoResources(
	db: D1Database,
	userId: string,
	resources: AgentResources,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO video_users (user_id, agent_id, environment_id, created_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET agent_id = excluded.agent_id,
				environment_id = excluded.environment_id, created_at = excluded.created_at`,
		)
		.bind(userId, resources.agentId, resources.environmentId, now)
		.run();
}

/**
 * 作っている途中の動画として記録する。すでにあれば記録せずfalse(1人1本まで)。
 * 行が残ったままにならないよう、時間切れより十分古い行は、置き換える
 */
export async function claimVideoJob(
	db: D1Database,
	job: VideoJobRecord,
	staleBefore: number,
): Promise<boolean> {
	await db
		.prepare("DELETE FROM video_jobs WHERE user_id = ? AND created_at < ?")
		.bind(job.userId, staleBefore)
		.run();
	const result = await db
		.prepare(
			`INSERT INTO video_jobs (user_id, guild_id, channel_id, message_id, created_at)
			VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING`,
		)
		.bind(job.userId, job.guildId, job.channelId, job.messageId, job.createdAt)
		.run();
	return result.meta.changes > 0;
}

export async function getVideoJob(
	db: D1Database,
	userId: string,
): Promise<VideoJobRecord | null> {
	const row = await db
		.prepare(
			"SELECT guild_id, channel_id, message_id, created_at FROM video_jobs WHERE user_id = ?",
		)
		.bind(userId)
		.first<{
			guild_id: string;
			channel_id: string;
			message_id: string;
			created_at: number;
		}>();
	return row === null
		? null
		: {
				userId,
				guildId: row.guild_id,
				channelId: row.channel_id,
				messageId: row.message_id,
				createdAt: row.created_at,
			};
}

export async function deleteVideoJob(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM video_jobs WHERE user_id = ?")
		.bind(userId)
		.run();
}

/** /delete: 動画の記録をすべて消す */
export async function deleteVideoRecordsOf(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM video_jobs WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM video_users WHERE user_id = ?").bind(userId),
	]);
}

/** 動画の仕事のDurable Object(利用者のIDで1つ決まる) */
export function videoJobStub(env: Env, userId: string) {
	return env.VIDEO_JOB.get(env.VIDEO_JOB.idFromName(userId));
}
