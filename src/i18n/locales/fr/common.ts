import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "OK",
  "common.cancel": "Annuler",
  "common.close": "Fermer",
  "common.save": "Enregistrer",
  "common.delete": "Supprimer",
  "common.remove": "Retirer",
  "common.edit": "Modifier",
  "common.done": "Terminé",
  "common.off": "Désactivé",
  "common.none": "Aucun",
  "common.retry": "Réessayer",
  "common.copy": "Copier",
  "common.loading": "Chargement…",
  "common.undo": "Annuler",
});
