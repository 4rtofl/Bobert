-- クレジットの寄付をやめる(#129)。全員が、使った分をsigwで払うため(仕様: llm-cost.md「AIの呼び出しと費用の負担」)
-- 寄付の表(0007_donations.sql)と、その索引を消す
DROP INDEX IF EXISTS idx_donations_donor;
DROP TABLE IF EXISTS donations;
