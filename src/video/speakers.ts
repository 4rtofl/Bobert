import { type Persona, ZUNDAMON } from "dopagakix/conversation";

/**
 * 動画の読み上げに選べる話者(VOICEVOX。仕様: docs/spec/behavior.md「動画の作成」)。
 * 音声ライブラリの利用規約で、企業での利用や商用利用に条件の付いた話者(青山龍星、もち子さん、後鬼、Voidoll、
 * ぞん子、No.7、ユーレイちゃん)は入れない。規約が確かめられなかった話者(雨晴はう)と、
 * サンドボックスで使うVOICEVOX ENGINE(0.25.2)に入っているか確かめられなかった新しい話者も入れない。
 * IDは、各話者のノーマルのスタイル(VOICEVOX/voicevox_vvm のREADMEの表)
 */
export interface VideoSpeaker {
	name: string;
	/** VOICEVOXのスタイルID(dopagakix の --speaker に渡す) */
	styleId: number;
}

export const VIDEO_SPEAKERS: readonly VideoSpeaker[] = [
	{ name: "ずんだもん", styleId: 3 },
	{ name: "四国めたん", styleId: 2 },
	{ name: "春日部つむぎ", styleId: 8 },
	{ name: "波音リツ", styleId: 9 },
	{ name: "玄野武宏", styleId: 11 },
	{ name: "白上虎太郎", styleId: 12 },
	{ name: "冥鳴ひまり", styleId: 14 },
	{ name: "九州そら", styleId: 16 },
	{ name: "剣崎雌雄", styleId: 21 },
	{ name: "WhiteCUL", styleId: 23 },
	{ name: "ちび式じい", styleId: 42 },
	{ name: "櫻歌ミコ", styleId: 43 },
	{ name: "小夜/SAYO", styleId: 46 },
	{ name: "ナースロボ＿タイプＴ", styleId: 47 },
	{ name: "†聖騎士 紅桜†", styleId: 51 },
	{ name: "雀松朱司", styleId: 52 },
	{ name: "麒ヶ島宗麟", styleId: 53 },
	{ name: "春歌ナナ", styleId: 54 },
	{ name: "猫使アル", styleId: 55 },
	{ name: "猫使ビィ", styleId: 58 },
	{ name: "中国うさぎ", styleId: 61 },
	{ name: "栗田まろん", styleId: 67 },
	{ name: "あいえるたん", styleId: 68 },
	{ name: "満別花丸", styleId: 69 },
	{ name: "琴詠ニア", styleId: 74 },
	{ name: "中部つるぎ", styleId: 94 },
	{ name: "離途", styleId: 99 },
	{ name: "黒沢冴白", styleId: 100 },
];

/** 既定の話者(ずんだもん) */
export const DEFAULT_SPEAKER: VideoSpeaker = VIDEO_SPEAKERS[0] as VideoSpeaker;

export function findSpeaker(name: unknown): VideoSpeaker | null {
	return VIDEO_SPEAKERS.find((speaker) => speaker.name === name) ?? null;
}

/**
 * 話者の口調(Dopagakixの既定に合わせる)。口調が決まっているのはずんだもんだけで、
 * ほかの話者はnull(読み上げ文は、です・ます調で書く)
 */
export function personaOf(speaker: VideoSpeaker): Persona | null {
	return ZUNDAMON.speakerNames.includes(speaker.name) ? ZUNDAMON : null;
}
