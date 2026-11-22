import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { fakeSigw } from "./sigw";

// テストのファイルごとに、D1にスキーマを作る
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// sigwを、プロバイダにそのまま中継する偽物にする(テストの中のfetchの偽物で応えられるように)
env.SIGW = fakeSigw;
