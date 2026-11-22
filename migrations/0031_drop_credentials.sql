-- AnthropicとOpenRouterのキーの登録をやめる(#128)。AIの呼び出しは、すべてBobert用のsigwのキーで行うため
-- (仕様: llm-cost.md「AIの呼び出しと費用の負担」)。保存していたキーの表(0001_initial.sql)と、
-- OpenRouterとの連携(OAuth PKCE)の途中の状態の表(0002_oauth_states.sql)を消す。
-- GitHubとの連携の途中の状態は、別の表(github_link_states)なので残す
DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS oauth_states;
