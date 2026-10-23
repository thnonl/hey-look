import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "OK",
  "common.cancel": "Hủy",
  "common.close": "Đóng",
  "common.save": "Lưu",
  "common.delete": "Xóa",
  "common.remove": "Gỡ bỏ",
  "common.edit": "Sửa",
  "common.done": "Xong",
  "common.off": "Tắt",
  "common.none": "Không",
  "common.default": "Mặc định",
  "common.retry": "Thử lại",
  "common.copy": "Sao chép",
  "common.loading": "Đang tải…",
  "common.undo": "Hoàn tác",
});
