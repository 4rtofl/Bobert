-- Jevを、Bobert用のsigwのキーで呼ぶようにしたので(#127。仕様: llm-cost.md「Jevの費用」)、
-- 利用者が登録したTypeSafeのAPIキーは使わなくなった。登録の仕組みと一緒に、保存していたキーを消す
DROP TABLE typesafe_credentials;
