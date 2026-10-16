import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "OK",
  "common.cancel": "Abbrechen",
  "common.close": "Schließen",
  "common.save": "Speichern",
  "common.delete": "Löschen",
  "common.remove": "Entfernen",
  "common.edit": "Bearbeiten",
  "common.done": "Fertig",
  "common.off": "Aus",
  "common.none": "Keine",
  "common.default": "Standard",
  "common.retry": "Erneut versuchen",
  "common.copy": "Kopieren",
  "common.loading": "Wird geladen…",
  "common.undo": "Rückgängig",
});
