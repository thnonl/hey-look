import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "确定",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.save": "保存",
  "common.delete": "删除",
  "common.remove": "移除",
  "common.edit": "编辑",
  "common.done": "完成",
  "common.off": "关",
  "common.none": "无",
  "common.retry": "重试",
  "common.copy": "复制",
  "common.loading": "正在加载…",
  "common.undo": "撤销",
});
