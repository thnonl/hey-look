// The sizes the picture toolbar offers (editor/PictureTools.tsx). Plain data, so a Node script reads it (scripts/test-signature-picture.mjs).
import type { Key } from "../i18n";

export type PictureSize = [Key, number | null];

/** The width of a picture put into a message (Medium), px. */
export const MEDIUM_PICTURE = 480;
/** Small / Medium / Large / Original of the message body. */
export const MESSAGE_PICTURE_SIZES: PictureSize[] = [["compose.pic.small", 240], ["compose.pic.medium", MEDIUM_PICTURE], ["compose.pic.large", 720], ["compose.pic.original", null]];
/** Signature and template pictures are logos: Small / Medium / Large are 120 / 240 / 360 px (240 is what a new signature picture gets, signaturePicture.ts). */
export const SIGNATURE_PICTURE_SIZES: PictureSize[] = [["compose.pic.small", 120], ["compose.pic.medium", 240], ["compose.pic.large", 360], ["compose.pic.original", null]];
/** Ctrl/Cmd+1, 2, 3 are the first three sizes, Ctrl/Cmd+0 the original; undefined for any other key. */
export const sizeForKey = (sizes: readonly PictureSize[], key: string): number | null | undefined => (key === "0" ? null : ["1", "2", "3"].includes(key) ? sizes[Number(key) - 1]?.[1] : undefined);
