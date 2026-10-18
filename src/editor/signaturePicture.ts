// A picture in a signature or a template (spec-rich-text.md REQ-25, AC-43, AC-44): it is stored in the HTML of the signature as a `data:` picture and goes out
// as an inline part of the message (messageBody.ts turns every `data:` picture into a `cid:` part, the signature's too). A picture is limited to 1 MB after
// it was made smaller; a logo is shown 240 px wide at first. The policy is pure: the caller passes what reads and shrinks a picture, so a plain Node script
// tests it (scripts/test-signature-picture.mjs).

/** The most a signature picture may weigh (as a `data:` picture, base64 included is not counted: the picture's own bytes). */
export const SIGNATURE_PICTURE_MAX = 1024 * 1024;
/** The width a new signature picture is shown with when it is wider. */
export const SIGNATURE_PICTURE_WIDTH = 240;
/** The widths a too heavy picture is made smaller to, one after the other, until it fits. */
export const SHRINK_STEPS: readonly number[] = [1600, 1200, 800, 600, 400];

export interface PictureIo {
  /** the picture made at most `maxW` px wide (same proportions) */
  resize(dataUrl: string, mime: string, maxW: number): Promise<{ dataUrl: string; mime: string; w: number; h: number }>;
  /** the bytes of a `data:` picture */
  bytes(dataUrl: string): number;
}

export type Fitted = { ok: true; dataUrl: string; mime: string; w: number; h: number; resized: boolean } | { ok: false };

/** The picture as it goes into the signature: as it is when it is light enough, else made smaller step by step; `ok: false` when even the smallest step is too heavy. */
export async function fitSignaturePicture(pic: { dataUrl: string; mime: string; w: number; h: number }, io: PictureIo, max = SIGNATURE_PICTURE_MAX): Promise<Fitted> {
  if (io.bytes(pic.dataUrl) <= max) return { ok: true, ...pic, resized: false };
  for (const step of SHRINK_STEPS) {
    if (step >= pic.w) continue; // (a bigger step than the picture is not smaller)
    const r = await io.resize(pic.dataUrl, pic.mime, step);
    if (io.bytes(r.dataUrl) <= max) return { ok: true, ...r, resized: true };
  }
  return { ok: false };
}

/** The `width` attribute a new signature picture gets: its own width, 240 px at most (null = the picture's own size). */
export const initialWidth = (w: number): number | null => (w > SIGNATURE_PICTURE_WIDTH ? SIGNATURE_PICTURE_WIDTH : null);
