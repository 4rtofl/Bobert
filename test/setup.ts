import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { saveSigwKey } from "../src/store/sigw-key";
import { ALL_SIGW_PROVIDERS, fakeSigw, TEST_SIGW_KEY } from "./sigw";

// テストのファイルごとに、D1にスキーマを作る
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Bobertのsigwのキーを、/sigw で登録したものとして、D1に入れておく
await saveSigwKey(env, {
	key: TEST_SIGW_KEY,
	last4: TEST_SIGW_KEY.slice(-4),
	providers: ALL_SIGW_PROVIDERS,
	registeredBy: "0",
	registeredAt: 0,
});

// sigwを、キーを確かめてプロバイダにそのまま中継する偽物にする(テストの中のfetchの偽物で応えられるように)
env.SIGW = fakeSigw;
