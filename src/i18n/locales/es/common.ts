import { defineLocale } from "../../types.ts";
import type ns from "../../ns/common.ts";

// Words used in many places. Add a key here only when the same wording is right everywhere; otherwise give the text its own key
// in the feature's dictionary (the same English word can need different words in vi / fr in different places).

export default defineLocale<typeof ns.en>({
  "common.ok": "Aceptar",
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.save": "Guardar",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.edit": "Editar",
  "common.done": "Listo",
  "common.off": "Desactivado",
  "common.none": "Ninguno",
  "common.retry": "Reintentar",
  "common.copy": "Copiar",
  "common.loading": "Cargando…",
  "common.undo": "Deshacer",
});
