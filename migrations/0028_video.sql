-- 会話を要約した縦型の動画を作る機能(#118。仕様: architecture.md「動画の作成」、behavior.md「動画の作成」)

-- /feat の「動画の作成」(既定はOFF)
ALTER TABLE users ADD COLUMN feat_video INTEGER NOT NULL DEFAULT 0;

-- 利用者ごとに、本人のAnthropicのアカウントに作った、動画用のエージェントの設定と環境。
-- Bobert Agent(agent_users)とは別に作る。ネットワークを絞り、道具を減らすため
CREATE TABLE video_users (
	user_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL,
	environment_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- 作っている途中の動画。1人1本まで(行があれば、次の動画は断る)。
-- 中身(台本やセッションのID)は、動画の仕事のDurable Object(VideoJob)が持つ
CREATE TABLE video_jobs (
	user_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	-- 動画を頼んだメッセージ(できた動画は、これへの返信として投稿する)
	message_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
