import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "OK",
  "common.cancel": "キャンセル",
  "common.close": "閉じる",
  "common.save": "保存",
  "common.delete": "削除",
  "common.remove": "削除",
  "common.edit": "編集",
  "common.done": "完了",
  "common.off": "オフ",
  "common.none": "なし",
  "common.retry": "再試行",
  "common.copy": "コピー",
  "common.loading": "読み込み中…",
  "common.undo": "元に戻す",
});
