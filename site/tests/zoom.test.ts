import { describe, it, expect } from 'vitest';
import { UNZOOMED, clampPan, containRect, fitBox, maxScale, zoomAt } from '../src/lib/zoom';

describe('containRect', () => {
  it('letterboxes a landscape image in a square box', () => {
    expect(containRect({ height: 400, width: 400 }, { height: 1000, width: 2000 })).toEqual({
      height: 200,
      left: 0,
      top: 100,
      width: 400,
    });
  });

  it('pillarboxes a portrait image in a wide box', () => {
    expect(containRect({ height: 400, width: 800 }, { height: 800, width: 400 })).toEqual({
      height: 400,
      left: 300,
      top: 0,
      width: 200,
    });
  });

  it('fills the box before the image has loaded (no natural size yet)', () => {
    expect(containRect({ height: 300, width: 500 }, { height: 0, width: 0 })).toEqual({
      height: 300,
      left: 0,
      top: 0,
      width: 500,
    });
    expect(containRect({ height: 300, width: 500 }, { height: 10, width: 0 }).width).toBe(500);
  });
});

describe('maxScale', () => {
  const content = { height: 400, left: 0, top: 0, width: 800 };

  it('allows 2x the native resolution for large sources', () => {
    expect(maxScale(content, { height: 3200, width: 6400 })).toBe(16);
  });

  it('never goes below 4x', () => {
    expect(maxScale(content, { height: 400, width: 800 })).toBe(4);
    expect(maxScale({ ...content, width: 0 }, { height: 400, width: 800 })).toBe(4);
  });
});

describe('clampPan', () => {
  const box = { height: 400, width: 400 };
  // Landscape image, letterboxed: 400 wide, 200 tall, 100px bands top and bottom.
  const content = { height: 200, left: 0, top: 100, width: 400 };

  it('keeps an unzoomed image exactly in place', () => {
    expect(clampPan({ scale: 1, x: 50, y: -30 }, box, content)).toEqual(UNZOOMED);
  });

  it('keeps an axis that still fits centered, while clamping the one that overflows', () => {
    // At 1.5x the image is 600x300: overflows horizontally, still fits vertically.
    const clamped = clampPan({ scale: 1.5, x: 100, y: 0 }, box, content);
    expect(clamped.x + 0).toBe(0); // can't pull the left edge inside the stage (+ 0 folds -0)
    expect(clamped.y).toBe(50 - 150); // centered: (400 - 300) / 2 - 100 * 1.5
  });

  it('stops panning at the far edge', () => {
    // At 3x the image is 1200x600 with its top at 300.
    const clamped = clampPan({ scale: 3, x: -5000, y: -5000 }, box, content);
    expect(clamped).toEqual({ scale: 3, x: 400 - 1200, y: 400 - 600 - 300 });
  });

  it('leaves an in-range pan untouched', () => {
    expect(clampPan({ scale: 3, x: -300, y: -400 }, box, content)).toEqual({ scale: 3, x: -300, y: -400 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const next = zoomAt(UNZOOMED, 2, { x: 100, y: 50 }, 8);
    expect(next).toEqual({ scale: 2, x: -100, y: -50 });
    // The image point that was at (100, 50) is (100, 50) in image space; after
    // zooming, 100 * 2 + (-100) = 100 — still under the cursor.
    expect(100 * next.scale + next.x).toBe(100);
  });

  it('clamps to [1, max]', () => {
    expect(zoomAt(UNZOOMED, 0.2, { x: 0, y: 0 }, 8).scale).toBe(1);
    expect(zoomAt(UNZOOMED, 20, { x: 0, y: 0 }, 8).scale).toBe(8);
  });
});

describe('fitBox', () => {
  // A 400x400 stage showing an 800x400 image: contained it is 400x200, with
  // 100px letterbox bands above and below. This mirrors the fixture in
  // tests/photo-viewer.test.ts.
  const stage = { height: 400, width: 400 };
  const content = { height: 200, left: 0, top: 100, width: 400 };

  it('scales so the box exactly fills the limiting axis', () => {
    // Middle half horizontally, full height: 200x200 in stage px => 2x.
    const state = fitBox({ bottom: 1, left: 0.25, right: 0.75, top: 0 }, stage, content, 8);
    expect(state.scale).toBe(2);
  });

  it('centers the box in the stage', () => {
    // Box center is at content (200, 200); at 2x that is (400, 400), and the
    // stage center is (200, 200), so the offset is -200 on each axis.
    const state = fitBox({ bottom: 1, left: 0.25, right: 0.75, top: 0 }, stage, content, 8);
    expect(state.x).toBe(-200);
    expect(state.y).toBe(-200);
  });

  it('never zooms past the supplied maximum', () => {
    const state = fitBox({ bottom: 0.52, left: 0.5, right: 0.52, top: 0.5 }, stage, content, 4);
    expect(state.scale).toBe(4);
  });

  it('never zooms out below 1x for a box larger than the stage', () => {
    const state = fitBox({ bottom: 1, left: 0, right: 1, top: 0 }, stage, content, 8);
    expect(state.scale).toBe(1);
  });

  it('keeps the image edges outside the stage for a box in the corner', () => {
    const state = fitBox({ bottom: 0.25, left: 0, right: 0.25, top: 0 }, stage, content, 8);
    // clampPan must not leave dead space to the left of the image.
    expect(state.x).toBeLessThanOrEqual(0);
    expect(state).toEqual(clampPan(state, stage, content));
  });

  it('returns UNZOOMED for a degenerate box', () => {
    expect(fitBox({ bottom: 0.5, left: 0.5, right: 0.5, top: 0.5 }, stage, content, 8)).toEqual(UNZOOMED);
  });

  it('includes content.left offset when computing rect position', () => {
    // Pillarboxed portrait: 400x800 image in 400x400 stage, contained at 200x400
    // with 100px bands left and right. This tests that content.left is not dropped
    // from the rect.left calculation.
    const pillarStage = { height: 400, width: 400 };
    const pillarContent = { height: 400, left: 100, top: 0, width: 200 };
    const pillarBox = { bottom: 0.625, left: 0.375, right: 0.625, top: 0.375 };
    // rect.left = 100 + 0.375*200 = 175, rect.width = 0.25*200 = 50
    // rect.top = 0 + 0.375*400 = 150, rect.height = 0.25*400 = 100
    // scale = min(8, max(1, min(400/50, 400/100))) = 4
    // x = 200 - 4*(175+25) = -600, y = 200 - 4*(150+50) = -600
    const state = fitBox(pillarBox, pillarStage, pillarContent, 8);
    expect(state).toEqual({ scale: 4, x: -600, y: -600 });
  });

  it('enforces scale floor of 1x even when content exceeds stage', () => {
    // Defensive contract test: a content rect from containRect can never exceed
    // its stage, so this is unreachable through the real viewer, but fitBox is
    // exported and the floor documents that it will not zoom out past 1x whatever
    // it is handed.
    const overStage = { height: 100, width: 100 };
    const overContent = { height: 400, left: 0, top: 0, width: 400 };
    const fullBox = { bottom: 1, left: 0, right: 1, top: 0 };
    const state = fitBox(fullBox, overStage, overContent, 8);
    expect(state.scale).toBe(1);
    expect(state).toEqual({ scale: 1, x: -150, y: -150 });
  });
});
