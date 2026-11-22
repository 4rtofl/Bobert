/**
 * 動画の作成で表示する文言(仕様: docs/spec/behavior.md「動画の作成」)。
 * 文言を変えるときは、仕様書も一緒に直す
 */

/** /feat のボタンの名前 */
export const VIDEO_FEATURE_LABEL = "動画の作成";

/** できたとき(頼んだメッセージへの返信。mp4を添付する) */
export function videoReadyMessage(speakerName: string): string {
	return `動画ができました。\n-# AIが会話を要約して作りました。音声: VOICEVOX:${speakerName}`;
}

/** 失敗したとき */
export const VIDEO_FAILED =
	"動画を作れませんでした。少し待ってから、もう一度頼んでください。";

/** 大きすぎて投稿できなかったとき。sizeは「12.3MB」の形、limitは「10MB」の形 */
export function videoTooLargeMessage(size: string, limit: string): string {
	return `動画が${size}あり、Discordに投稿できる${limit}を超えたので、投稿できませんでした。対象の会話を短くして、もう一度頼んでください。`;
}

/** 時間切れ(15分) */
export const VIDEO_TIMED_OUT =
	"15分たっても動画ができなかったので、作るのをやめました。もう一度頼んでください。";

/** /delete の確認に足す文(作っている途中の動画があるときだけ) */
export const DELETE_VIDEO_NOTE = "作っている途中の動画も、作るのをやめます。";
