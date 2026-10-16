// Where the toolbar of a picture in the compose body sits, in the coordinates of the scrolling body (pixels from its top-left, scroll
// included). Pure geometry; Compose.tsx measures the toolbar and applies the result. The toolbar goes above the picture, below it
// when there is no room above, over the picture's visible part when there is room neither above nor below, and is moved sideways
// so that all of it stays inside the pane (fitInWindow).
import { fitInWindow } from "./fitInWindow.ts"; // (explicit path: scripts/test-picture-tools.mjs loads this file with node)

export interface PictureToolsInput {
  /** the picture */
  imgLeft: number;
  imgWidth: number;
  imgTop: number;
  imgBottom: number;
  /** the visible part of the body: scroll offset and size */
  scrollTop: number;
  paneWidth: number;
  paneHeight: number;
  /** the toolbar as it is laid out now (it wraps to more rows in a narrow pane, so the height is measured, not assumed) */
  width: number;
  height: number;
}

export function placePictureTools(i: PictureToolsInput, gap = 6, edge = 8): { left: number; top: number } {
  // centred on the first 360 px of the picture (a wide picture would put it out of sight), then back inside the pane
  const want = i.imgLeft + Math.min(i.imgWidth, 360) / 2 - i.width / 2;
  const left = want + fitInWindow({ left: want, right: want + i.width, top: 0, bottom: 0 }, i.paneWidth, Infinity, edge).shift;
  const above = i.imgTop - gap - i.height;
  if (above >= i.scrollTop) return { left, top: above };
  const below = i.imgBottom + gap;
  if (below + i.height <= i.scrollTop + i.paneHeight) return { left, top: below };
  // neither fits: over the visible part of the picture, but only when the pane is tall enough to show all of the toolbar there;
  // in a pane that is shorter than the toolbar (a small window) it stays under the picture, where scrolling reaches it
  return { left, top: i.paneHeight >= i.height + 2 * gap ? i.scrollTop + gap : below };
}
