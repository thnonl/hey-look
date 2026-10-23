import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "OK",
  "common.cancel": "Отмена",
  "common.close": "Закрыть",
  "common.save": "Сохранить",
  "common.delete": "Удалить",
  "common.remove": "Убрать",
  "common.edit": "Изменить",
  "common.done": "Готово",
  "common.off": "Выкл.",
  "common.none": "Нет",
  "common.retry": "Повторить",
  "common.copy": "Копировать",
  "common.loading": "Загрузка…",
  "common.undo": "Отменить",
});
