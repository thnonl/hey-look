// Where the toolbar of a picture in the compose body sits, in the coordinates of the scrolling body (pixels from its top-left, scroll
// included). Pure geometry; Compose.tsx measures the toolbar and applies the result. The toolbar goes above the picture, below it
// when there is no room above, over the picture's visible part when there is room neither above nor below, and is moved sideways
// so that all of it stays inside the pane (fitInWindow). Over the picture it keeps clear of the picture's top and bottom edges: the resize
// handles (editor/insertUi.tsx PictureHandles) sit in the four corners INSIDE the picture, `HANDLE_ZONE` px deep, and the toolbar never touches them
// (v1.0.6 QA round 3, BUG-R3-2: at 1280 x 720 the corner handles sat on "Small" and "As attachment" and the toolbar covered the picture's top edge).
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

/** The size of a resize handle (px); they lie inside the corners of the picture. */
export const HANDLE_SIZE = 10;
/** How far from the picture's top and bottom edge the toolbar stays when it is over the picture: the handle and a little air. */
export const HANDLE_ZONE = HANDLE_SIZE + 6;

export function placePictureTools(i: PictureToolsInput, gap = 6, edge = 8): { left: number; top: number } {
  // centred on the first 360 px of the picture (a wide picture would put it out of sight), then back inside the pane
  const want = i.imgLeft + Math.min(i.imgWidth, 360) / 2 - i.width / 2;
  const left = want + fitInWindow({ left: want, right: want + i.width, top: 0, bottom: 0 }, i.paneWidth, Infinity, edge).shift;
  const above = i.imgTop - gap - i.height;
  if (above >= i.scrollTop) return { left, top: above };
  const below = i.imgBottom + gap;
  if (below + i.height <= i.scrollTop + i.paneHeight) return { left, top: below };
  // neither fits: over the visible part of the picture, between its top and bottom handles (an edge that is out of view carries no handle: `gap` from the pane's edge there)
  const viewTop = i.scrollTop;
  const viewBottom = i.scrollTop + i.paneHeight;
  const lo = Math.max(i.imgTop, viewTop) + (i.imgTop >= viewTop ? HANDLE_ZONE : gap);
  const hi = Math.min(i.imgBottom, viewBottom) - (i.imgBottom <= viewBottom ? HANDLE_ZONE : gap) - i.height;
  if (hi >= lo) return { left, top: lo };
  // the picture is too low for that: at the top of the pane when the pane is tall enough to show all of the toolbar there;
  // in a pane that is shorter than the toolbar (a small window) it stays under the picture, where scrolling reaches it
  return { left, top: i.paneHeight >= i.height + 2 * gap ? viewTop + gap : below };
}
