import { describe, it, expect } from 'vitest';
import {
  displayedSize,
  expandToPhotoAspect,
  toPixelRect,
  type BoundingBox,
} from '../src/lib/bounding-box';

describe('displayedSize', () => {
  it('leaves orientations 1-4 as stored', () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(displayedSize({ height: 400, orientation, width: 600 })).toEqual({ height: 400, width: 600 });
    }
  });

  it('transposes orientations 5-8', () => {
    for (const orientation of [5, 6, 7, 8]) {
      expect(displayedSize({ height: 400, orientation, width: 600 })).toEqual({ height: 600, width: 400 });
    }
  });

  it('treats missing metadata as unrotated and zero-sized', () => {
    expect(displayedSize({})).toEqual({ height: 0, width: 0 });
  });
});

describe('toPixelRect', () => {
  it('converts a box to integer pixels', () => {
    const box: BoundingBox = { bottom: 0.75, left: 0.25, right: 0.5, top: 0.5 };
    expect(toPixelRect(box, { height: 400, width: 800 })).toEqual({
      height: 100,
      left: 200,
      top: 200,
      width: 200,
    });
  });

  it('rounds outward so the whole box is covered', () => {
    // 0.1 * 1000 = 100.00000000000001 in float, and 0.3 * 1000 = 300.00000000000006.
    const box: BoundingBox = { bottom: 0.3001, left: 0.1001, right: 0.3001, top: 0.1001 };
    const rect = toPixelRect(box, { height: 1000, width: 1000 });
    expect(rect.left).toBe(100);
    expect(rect.top).toBe(100);
    expect(rect.left + rect.width).toBe(301);
    expect(rect.top + rect.height).toBe(301);
  });

  it('never exceeds the image bounds for a full-frame box', () => {
    const box: BoundingBox = { bottom: 1, left: 0, right: 1, top: 0 };
    expect(toPixelRect(box, { height: 400, width: 600 })).toEqual({
      height: 400,
      left: 0,
      top: 0,
      width: 600,
    });
  });

  it('keeps at least one pixel on each axis for a sub-pixel box', () => {
    const box: BoundingBox = { bottom: 0.5001, left: 0.5, right: 0.5001, top: 0.5 };
    const rect = toPixelRect(box, { height: 100, width: 100 });
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(100);
  });

  it('keeps a box at the far edge inside the image', () => {
    const box: BoundingBox = { bottom: 1, left: 0.999, right: 1, top: 0.999 };
    const rect = toPixelRect(box, { height: 100, width: 100 });
    expect(rect.left + rect.width).toBeLessThanOrEqual(100);
    expect(rect.top + rect.height).toBeLessThanOrEqual(100);
  });
});

describe('expandToPhotoAspect', () => {
  it('grows the short axis symmetrically', () => {
    // 0.2 wide x 0.4 tall, centered: grows to 0.4 x 0.4.
    const result = expandToPhotoAspect({ bottom: 0.7, left: 0.4, right: 0.6, top: 0.3 });
    expect(result.bottom).toBe(0.7);
    expect(result.left).toBeCloseTo(0.3, 10);
    expect(result.right).toBeCloseTo(0.7, 10);
    expect(result.top).toBeCloseTo(0.3, 10);
  });

  it('leaves an already-square box alone', () => {
    const box: BoundingBox = { bottom: 0.6, left: 0.2, right: 0.4, top: 0.4 };
    expect(expandToPhotoAspect(box)).toEqual(box);
  });

  it('slides inward instead of overflowing the left edge', () => {
    const grown = expandToPhotoAspect({ bottom: 0.9, left: 0, right: 0.1, top: 0.5 });
    expect(grown.left).toBe(0);
    expect(grown.right).toBeCloseTo(0.4, 10);
    expect(grown.bottom - grown.top).toBeCloseTo(grown.right - grown.left, 10);
  });

  it('slides inward instead of overflowing the bottom edge', () => {
    const grown = expandToPhotoAspect({ bottom: 1, left: 0.4, right: 0.8, top: 0.9 });
    expect(grown.bottom).toBe(1);
    expect(grown.top).toBeCloseTo(0.6, 10);
  });

  it('clamps to the full frame when the box is wider than it is tall by more than the frame', () => {
    const grown = expandToPhotoAspect({ bottom: 0.55, left: 0, right: 1, top: 0.45 });
    expect(grown.bottom).toBe(1);
    expect(grown.left).toBe(0);
    expect(grown.right).toBe(1);
    expect(grown.top).toBeCloseTo(0, 10);
  });
});
