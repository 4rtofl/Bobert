import { describe, expect, it } from "vitest";
import { fromDiscord } from "../src/respond/history";
import {
	htmlToText,
	MAX_PAGE_CHARS,
	readPage,
	urlsIn,
} from "../src/video/pages";
import { ALICE, discordMessage } from "./fixtures";

function messageWith(content: string) {
	return fromDiscord(discordMessage("1", ALICE, content), "900");
}

describe("urlsIn", () => {
	it("本文のURLを、重複を除いて出てきた順に拾う。かっこや句読点は外し、Discordのページは除く", () => {
		expect(
			urlsIn(
				messageWith(
					"これ(https://example.com/a)と<https://example.org/b?x=1#top>。https://example.com/a、https://discord.com/channels/1/2/3 https://ja.wikipedia.org/wiki/Foo_(bar)",
				),
			),
		).toEqual([
			"https://example.com/a",
			"https://example.org/b?x=1",
			"https://ja.wikipedia.org/wiki/Foo_(bar)",
		]);
	});
});

describe("htmlToText", () => {
	it("スクリプトやメニューを除いて本文の文字にし、文字参照を戻す", async () => {
		const { title, text } = await htmlToText(
			"<html><head><title>題 &amp; 副題</title><script>var a = 1;</script></head><body><header>サイト名</header><p>一段落目&nbsp;です。</p><ul><li>項目&#x41;</li><li>項目&#66;</li></ul><footer>著作権</footer></body></html>",
		);
		expect(title).toBe("題 & 副題");
		expect(text).toBe("一段落目 です。\n項目A\n項目B");
	});
});

describe("readPage", () => {
	it("長いページは上限で切る", async () => {
		const result = await readPage(
			"https://example.com/",
			async () =>
				new Response(`<p>${"あ".repeat(MAX_PAGE_CHARS + 10)}</p>`, {
					headers: { "content-type": "text/html" },
				}),
		);
		expect(result).toMatchObject({ ok: true, truncated: true });
		expect(result.ok && result.text.length).toBe(MAX_PAGE_CHARS);
	});

	it("文字コードを、<meta>から決める", async () => {
		const bytes = new Uint8Array([
			...new TextEncoder().encode('<meta charset="shift_jis"><p>'),
			0x82,
			0xa0, // 「あ」(Shift_JIS)
			...new TextEncoder().encode("</p>"),
		]);
		const result = await readPage(
			"https://example.com/",
			async () =>
				new Response(bytes, { headers: { "content-type": "text/html" } }),
		);
		expect(result).toMatchObject({ ok: true, text: "あ" });
	});

	it("文字のページでなければ、読めなかった理由を返す", async () => {
		expect(
			await readPage(
				"https://example.com/a.png",
				async () =>
					new Response("x", { headers: { "content-type": "image/png" } }),
			),
		).toEqual({
			url: "https://example.com/a.png",
			ok: false,
			reason: "文字のページではありません(image/png)",
		});
		expect(
			await readPage("https://example.com/", async () => {
				throw new TypeError("network");
			}),
		).toMatchObject({ ok: false, reason: "接続できませんでした" });
	});
});
