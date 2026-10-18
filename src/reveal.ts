// "Show in folder" for a saved file: the one place that asks the backend to select it in Explorer / Finder / the file manager (save toast, the
// "After saving" setting, the attachment card, Save all). It is never silent: when nothing could show the file, an error toast says which file and why.
import { api } from "./api";
import { t } from "./i18n";
import { friendlyError, useStore } from "./store";

/** The last part of a path (the file's name), whichever separator the system uses. */
export const fileNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export async function revealSaved(path: string): Promise<void> {
  try {
    await api.attachmentReveal(path);
  } catch (e) {
    const name = fileNameOf(path);
    useStore.getState().showToast(() => t("reading.att.couldntReveal", { name, error: friendlyError(e) }), undefined, "error");
  }
}
