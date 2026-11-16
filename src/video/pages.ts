import type { StoredMessageInput } from "../queue/messages";

/**
 * 動画のために、発言に貼られたURLの先のページを読む(仕様: docs/spec/architecture.md「動画の作成」)。
 * Discordのリンクのプレビュー(Embed)には、タイトルと説明文しか入っていないので、ページを取得して本文の文字にする
 */

/** 1回の返答で読むページの数 */
export const MAX_PAGES = 10;
/** 1ページの本文として渡す文字数。超えた分は切る */
export const MAX_PAGE_CHARS = 10_000;
/** 1ページを取得するのを待つ時間 */
const FETCH_TIMEOUT_MS = 10_000;
/** 読み込むページの大きさ(バイト)。超えた分は読まない */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** ページを取得するときに名乗るUser-Agent */
const USER_AGENT =
	"Mozilla/5.0 (compatible; Bobert/1.0; +https://github.com/4rtoflow/Bobert)";

/** 読まないホスト。Discordのページは、ログインしないと中身が読めない */
const SKIPPED_HOSTS = [
	"discord.com",
	"discordapp.com",
	"discord.gg",
	"discordapp.net",
];

/** 読んだページ */
export type PageResult =
	| { url: string; ok: true; title: string; text: string; truncated: boolean }
	| { url: string; ok: false; reason: string };

/** ページを取得する(テストで差し替える) */
export type PageFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** 発言の本文に貼られたURL。重複は除き、出てきた順に返す。Discordのページは除く */
export function urlsIn(message: StoredMessageInput): string[] {
	const found: string[] = [];
	// 「<https://…>」(プレビューを出さないリンク)も拾う。URLはASCIIの文字だけとし、続く日本語や「<>\"'`|」で区切る
	for (const match of message.content.matchAll(
		/https?:\/\/[!#-&(-;=?-_a-{}~]+/g,
	)) {
		const url = normalizeUrl(match[0]);
		if (url !== null && !found.includes(url)) {
			found.push(url);
		}
	}
	return found;
}

function normalizeUrl(raw: string): string | null {
	let text = raw.replace(/[.,;:!?\]}]+$/, "");
	// 「(https://…)」のように、かっこで囲んだときの閉じかっこ。URLの中で対になるかっこは残す
	while (
		text.endsWith(")") &&
		text.split(")").length > text.split("(").length
	) {
		text = text.slice(0, -1).replace(/[.,;:!?]+$/, "");
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.username !== "" || url.password !== "") {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (
		SKIPPED_HOSTS.some(
			(skipped) => host === skipped || host.endsWith(`.${skipped}`),
		)
	) {
		return null;
	}
	url.hash = "";
	return url.toString();
}

/** ページを取得し、本文の文字にする。読めなければ、理由を返す */
export async function readPage(
	url: string,
	fetcher: PageFetcher = fetch,
): Promise<PageResult> {
	let response: Response;
	try {
		response = await fetcher(url, {
			redirect: "follow",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
				"Accept-Language": "ja,en;q=0.8",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			url,
			ok: false,
			reason:
				error instanceof Error && error.name === "TimeoutError"
					? "時間内に応答がありませんでした"
					: "接続できませんでした",
		};
	}
	if (!response.ok) {
		await response.body?.cancel();
		return { url, ok: false, reason: `HTTP ${response.status}` };
	}
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	const isHtml = type.includes("html");
	if (!isHtml && !type.startsWith("text/plain")) {
		await response.body?.cancel();
		return {
			url,
			ok: false,
			reason: `文字のページではありません(${type.split(";")[0] || "種類不明"})`,
		};
	}
	const bytes = await readLimited(response);
	const source = decode(bytes, type);
	const { title, text } = isHtml
		? await htmlToText(source)
		: { title: "", text: tidy(source) };
	if (text === "") {
		return { url, ok: false, reason: "本文の文字がありませんでした" };
	}
	const truncated = text.length > MAX_PAGE_CHARS;
	return {
		url,
		ok: true,
		title,
		text: truncated ? text.slice(0, MAX_PAGE_CHARS) : text,
		truncated,
	};
}

/** 上限の大きさまで読む */
async function readLimited(response: Response): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (reader === undefined) {
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_PAGE_BYTES) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	const bytes = new Uint8Array(Math.min(size, MAX_PAGE_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.length - offset);
		bytes.set(part, offset);
		offset += part.length;
		if (offset >= bytes.length) {
			break;
		}
	}
	return bytes;
}

/** 文字コードは、Content-Typeか、HTMLの<meta>で決める。分からなければUTF-8 */
function decode(bytes: Uint8Array, contentType: string): string {
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
	const charset =
		/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
		"utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** 文字にしない要素(中身ごと飛ばす) */
const SKIPPED_ELEMENTS = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"nav",
	"header",
	"footer",
	"aside",
	"form",
	"button",
	"select",
];
/** 区切りに改行を入れる要素 */
const BLOCK_ELEMENTS = [
	"p",
	"div",
	"br",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"tr",
	"blockquote",
	"pre",
	"section",
	"article",
	"dt",
	"dd",
	"figcaption",
	"hr",
];

/**
 * HTMLを、タイトルと本文の文字にする。<article>か<main>があれば、その中だけを本文にする
 * (ページの周りのメニューなどを入れないため)
 */
export async function htmlToText(
	html: string,
): Promise<{ title: string; text: string }> {
	let title = "";
	const parts = { all: [] as string[], main: [] as string[] };
	let skipDepth = 0;
	let mainDepth = 0;
	let inTitle = false;
	const push = (text: string) => {
		parts.all.push(text);
		if (mainDepth > 0) {
			parts.main.push(text);
		}
	};
	const rewriter = new HTMLRewriter()
		.on("title", {
			element(element) {
				inTitle = true;
				element.onEndTag(() => {
					inTitle = false;
				});
			},
		})
		.on(SKIPPED_ELEMENTS.join(","), {
			element(element) {
				skipDepth++;
				element.onEndTag(() => {
					skipDepth--;
				});
			},
		})
		.on("article, main", {
			element(element) {
				mainDepth++;
				element.onEndTag(() => {
					mainDepth--;
				});
			},
		})
		.on(BLOCK_ELEMENTS.join(","), {
			element(element) {
				push("\n");
				if (element.tagName !== "br" && element.tagName !== "hr") {
					element.onEndTag(() => push("\n"));
				}
			},
		})
		.onDocument({
			text(chunk) {
				if (inTitle) {
					title += chunk.text;
					return;
				}
				if (skipDepth > 0) {
					return;
				}
				push(chunk.text);
			},
		});
	await rewriter
		.transform(new Response(html, { headers: { "content-type": "text/html" } }))
		.arrayBuffer();
	const main = tidy(decodeEntities(parts.main.join("")));
	return {
		title: tidy(decodeEntities(title)),
		text: main !== "" ? main : tidy(decodeEntities(parts.all.join(""))),
	};
}

/** 行ごとに空白を詰め、空行を減らす */
function tidy(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[\s ]+/g, " ").trim())
		.filter((line) => line !== "")
		.join("\n");
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	laquo: "«",
	raquo: "»",
	copy: "©",
};

/** HTMLの文字参照を文字に戻す(HTMLRewriterの文字は、参照のまま渡ってくる) */
function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(whole, name: string) => {
			if (name.startsWith("#")) {
				const code =
					name[1] === "x" || name[1] === "X"
						? Number.parseInt(name.slice(2), 16)
						: Number.parseInt(name.slice(1), 10);
				return code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: whole;
			}
			return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
		},
	);
}
