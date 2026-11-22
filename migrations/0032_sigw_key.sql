-- Bobertが使うsigwのキー(#135。仕様: llm-cost.md「AIの呼び出しと費用の負担」、behavior.md「sigwキーの登録」)。
-- Workerのシークレット(SIGW_ANTHROPIC_KEY など)の代わりに、サーバー管理者が /sigw で登録する。
-- キーは1つで、Bobert全体で使う(Bobertを入れたすべてのサーバーで同じ)ので、行は1つだけにする。
-- 時刻はUNIX時間のミリ秒
CREATE TABLE sigw_key (
	-- いつも1。行を1つだけにするため
	id INTEGER PRIMARY KEY CHECK (id = 1),
	-- 暗号化に使った鍵(CREDENTIAL_ENCRYPTION_KEYS)の番号と、AES-GCMの初期化ベクトルと暗号文(Base64)
	key_version INTEGER NOT NULL,
	iv TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	-- キーの末尾4文字(/sigw の画面に出す。sigwが返したもの)
	last4 TEXT NOT NULL,
	-- 登録したときに、sigwが返した呼べるプロバイダ(JSONの配列)。sigwに問い合わせられないときの、予備に使う
	providers TEXT NOT NULL,
	-- 登録したサーバー管理者のDiscordのIDと、登録した時刻
	registered_by TEXT NOT NULL,
	registered_at INTEGER NOT NULL
);
