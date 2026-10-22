// Pure pan/zoom geometry for the photo viewer. The image element fills its
// stage with `object-fit: contain` and is transformed with
// `translate(x, y) scale(scale)` from its top-left corner, so every value
// here is in stage pixels.

import type { BoundingBox } from './bounding-box';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  height: number;
  width: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

export interface ZoomState extends Point {
  scale: number;
}

export const UNZOOMED: ZoomState = { scale: 1, x: 0, y: 0 };

// Never allow less than this much zoom, even when the source image is no
// larger than the stage — a 4x look at a small image is still useful.
const MIN_MAX_SCALE = 4;

/** Where `object-fit: contain` draws an image of `natural` size inside `box`. */
export function containRect(box: Size, natural: Size): Rect {
  if (natural.width <= 0 || natural.height <= 0) return { height: box.height, left: 0, top: 0, width: box.width };
  const ratio = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * ratio;
  const height = natural.height * ratio;
  return { height, left: (box.width - width) / 2, top: (box.height - height) / 2, width };
}

/** Enough zoom to see the source at 2x its native pixels. */
export function maxScale(content: Rect, natural: Size): number {
  if (content.width <= 0) return MIN_MAX_SCALE;
  return Math.max(MIN_MAX_SCALE, (natural.width / content.width) * 2);
}

function clampAxis(offset: number, scale: number, boxLength: number, start: number, length: number): number {
  const scaledStart = start * scale;
  const scaledLength = length * scale;
  // Smaller than the stage on this axis: keep it centered.
  if (scaledLength <= boxLength) return (boxLength - scaledLength) / 2 - scaledStart;
  // Larger: never pull an edge of the image inside the stage.
  return Math.min(-scaledStart, Math.max(boxLength - scaledLength - scaledStart, offset));
}

export function clampPan(state: ZoomState, box: Size, content: Rect): ZoomState {
  return {
    scale: state.scale,
    x: clampAxis(state.x, state.scale, box.width, content.left, content.width),
    y: clampAxis(state.y, state.scale, box.height, content.top, content.height),
  };
}

/** Zoom to `targetScale` (clamped to [1, max]) keeping `point` fixed on screen. */
export function zoomAt(state: ZoomState, targetScale: number, point: Point, max: number): ZoomState {
  const scale = Math.min(max, Math.max(1, targetScale));
  const ratio = scale / state.scale;
  return {
    scale,
    x: point.x - (point.x - state.x) * ratio,
    y: point.y - (point.y - state.y) * ratio,
  };
}

/**
 * The zoom state that frames `box` as large as possible while keeping all of
 * it visible. The box is normalized against the image, so it maps into stage
 * pixels through `content` first; taking the `min` of the two axis ratios is
 * what keeps the whole box in view without changing the stage's aspect ratio.
 */
export function fitBox(box: BoundingBox, stage: Size, content: Rect, max: number): ZoomState {
  const rect: Rect = {
    height: (box.bottom - box.top) * content.height,
    left: content.left + box.left * content.width,
    top: content.top + box.top * content.height,
    width: (box.right - box.left) * content.width,
  };
  if (rect.width <= 0 || rect.height <= 0) return UNZOOMED;
  const scale = Math.min(max, Math.max(1, Math.min(stage.width / rect.width, stage.height / rect.height)));
  return clampPan(
    {
      scale,
      x: stage.width / 2 - scale * (rect.left + rect.width / 2),
      y: stage.height / 2 - scale * (rect.top + rect.height / 2),
    },
    stage,
    content
  );
}
