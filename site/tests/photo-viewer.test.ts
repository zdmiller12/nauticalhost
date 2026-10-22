// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initPhotoViewer } from '../src/scripts/photo-viewer';

// A 400x400 stage showing an 800x400 image: contained, it's 400x200 with
// 100px bands above and below, and the zoom limit is 4x.
function renderViewer(): HTMLElement {
  document.body.innerHTML = `
    <figure data-photo-viewer>
      <div data-viewer-stage><img data-viewer-image src="x.jpg" alt="" /></div>
      <button data-viewer-action="zoom-out"></button>
      <button data-viewer-action="zoom-in"></button>
      <button data-viewer-action="reset"></button>
      <button data-viewer-action="expand"></button>
    </figure>
  `;
  const stage = document.querySelector('[data-viewer-stage]')!;
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 400 });
  const image = document.querySelector('[data-viewer-image]')!;
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 });
  return document.querySelector<HTMLElement>('[data-photo-viewer]')!;
}

const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;
const stage = () => q<HTMLElement>('[data-viewer-stage]');
const image = () => q<HTMLImageElement>('[data-viewer-image]');
const button = (action: string) => q<HTMLButtonElement>(`[data-viewer-action="${action}"]`);
const root = () => q<HTMLElement>('[data-photo-viewer]');

function transform(): { scale: number; x: number; y: number } {
  const match = /translate\(([-+\d.e]+)px, ([-+\d.e]+)px\) scale\(([-+\d.e]+)\)/.exec(image().style.transform)!;
  return { scale: Number(match[3]), x: Number(match[1]), y: Number(match[2]) };
}

// happy-dom's getBoundingClientRect is all zeros, so client coords are stage coords.
const pointer = (type: string, pointerId: number, clientX: number, clientY: number) =>
  stage().dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId }));

function key(name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, key: name });
  window.dispatchEvent(event);
  return event;
}

function wheel(deltaY: number, deltaMode = 0): WheelEvent {
  const event = new WheelEvent('wheel', { cancelable: true, deltaMode, deltaY });
  // happy-dom's WheelEvent drops the MouseEvent coordinates browsers provide.
  Object.defineProperties(event, { clientX: { value: 200 }, clientY: { value: 200 } });
  stage().dispatchEvent(event);
  return event;
}

function renderViewerWithBoxes(boxes: { bottom: number; left: number; right: number; top: number }[]): HTMLElement {
  document.body.innerHTML = `
    <figure data-photo-viewer>
      <div data-viewer-stage>
        <img data-viewer-image src="x.jpg" alt="" />
        <div data-viewer-overlay>
          ${boxes
            .map(
              (box, index) =>
                `<div data-viewer-box="${index}" data-box='${JSON.stringify(box)}' class="hidden"></div>`
            )
            .join('')}
        </div>
      </div>
      <button data-viewer-action="zoom-out"></button>
      <button data-viewer-action="zoom-in"></button>
      <button data-viewer-action="reset"></button>
      <button data-viewer-action="expand"></button>
      <ul data-viewer-chips>
        ${boxes
          .map(
            (_, index) => `
          <li>
            <button data-viewer-zoom-box="${index}"></button>
            <button data-viewer-toggle-box="${index}" aria-pressed="true"></button>
          </li>`
          )
          .join('')}
      </ul>
    </figure>`;
  const stage = document.querySelector('[data-viewer-stage]')!;
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 400 });
  const image = document.querySelector('[data-viewer-image]')!;
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 });
  return document.querySelector<HTMLElement>('[data-photo-viewer]')!;
}

describe('initPhotoViewer with boxes', () => {
  it('opens zoomed to the first box', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    expect(image.style.transform).toBe('translate(-200px, -200px) scale(2)');
    expect(root.hasAttribute('data-zoomed')).toBe(true);
  });

  it('positions an outline in stage pixels, not via a CSS transform', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const outline = root.querySelector<HTMLElement>('[data-viewer-box="0"]')!;
    // Box is content (100,100)-(300,300); at scale 2 with offset -200 that is
    // stage (0,0)-(400,400).
    expect(outline.style.left).toBe('0px');
    expect(outline.style.top).toBe('0px');
    expect(outline.style.width).toBe('400px');
    expect(outline.style.height).toBe('400px');
    expect(outline.style.transform).toBe('');
  });

  it('re-fits to the first box once the image loads, against the current layout', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    expect(image.style.transform).toBe('translate(-200px, -200px) scale(2)');

    // The stage grows taller before the image finishes loading (e.g. a
    // responsive layout shift); applyView() re-derives the box fit against
    // the new geometry rather than replaying the stale transform.
    const stageEl = root.querySelector<HTMLElement>('[data-viewer-stage]')!;
    Object.defineProperty(stageEl, 'clientHeight', { configurable: true, value: 800 });
    image.dispatchEvent(new Event('load'));
    expect(image.style.transform).toBe('translate(-200px, -400px) scale(2)');
    expect(root.hasAttribute('data-zoomed')).toBe(true);
  });

  it('keeps the whole-photo view across a load once the user has reset', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    root.querySelector<HTMLButtonElement>('[data-viewer-action="reset"]')!.click();
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');

    // The reset expressed the user's intent as 'whole', not a transform, so a
    // later load must not snap back to the box fit.
    image.dispatchEvent(new Event('load'));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('shows outlines by default', () => {
    const root = renderViewerWithBoxes([{ bottom: 1, left: 0.25, right: 0.75, top: 0 }]);
    initPhotoViewer(root);

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(false);
  });

  it('leaves a boxless viewer unzoomed and behaving as before', () => {
    const root = renderViewerWithBoxes([]);
    initPhotoViewer(root);

    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(root.hasAttribute('data-zoomed')).toBe(false);
  });
});

describe('initPhotoViewer box controls', () => {
  const twoBoxes = [
    { bottom: 1, left: 0.25, right: 0.75, top: 0 },
    { bottom: 0.5, left: 0, right: 0.25, top: 0 },
  ];

  let stop: () => void = () => {};

  afterEach(() => {
    stop();
    document.documentElement.style.overflow = '';
  });

  it('zooms to the chosen box', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    stop = initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-zoom-box="1"]')!.click();

    // The second box is a quarter wide and half tall of a 400x200 content
    // rect, so it fits at 4x -- a different transform from the first box.
    expect(image.style.transform).not.toBe('translate(-200px, -200px) scale(2)');
    expect(root.hasAttribute('data-zoomed')).toBe(true);
  });

  it('toggles one outline without affecting the other', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    stop = initPhotoViewer(root);
    const toggle = root.querySelector<HTMLButtonElement>('[data-viewer-toggle-box="0"]')!;

    toggle.click();

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('[data-viewer-box="1"]')!.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();

    expect(root.querySelector('[data-viewer-box="0"]')!.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the box framing when expanding to full view', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    stop = initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;
    const before = image.style.transform;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="expand"]')!.click();

    // The stage size is unchanged in happy-dom, so re-deriving the same view
    // must reproduce the same transform -- the point is that it is NOT reset
    // to scale(1), which is what the old render(UNZOOMED) did.
    expect(image.style.transform).toBe(before);
    expect(image.style.transform).not.toBe('translate(0px, 0px) scale(1)');
  });

  it('resets to the whole photo and stays there across a resize', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    stop = initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="reset"]')!.click();
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');

    window.dispatchEvent(new Event('resize'));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('keeps a manual zoom across a resize instead of snapping back to a box', () => {
    const root = renderViewerWithBoxes(twoBoxes);
    stop = initPhotoViewer(root);
    const image = root.querySelector<HTMLImageElement>('[data-viewer-image]')!;

    root.querySelector<HTMLButtonElement>('[data-viewer-action="zoom-in"]')!.click();
    const manual = image.style.transform;

    window.dispatchEvent(new Event('resize'));
    expect(image.style.transform).toBe(manual);
  });
});

let teardown: () => void = () => {};

describe('initPhotoViewer', () => {
  beforeEach(() => {
    teardown = initPhotoViewer(renderViewer());
  });

  afterEach(() => {
    teardown();
    document.documentElement.style.overflow = '';
  });

  it('starts unzoomed, inline, and scrollable', () => {
    expect(transform()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(root().hasAttribute('data-zoomed')).toBe(false);
    expect(stage().style.touchAction).toBe('pan-y');
    expect(button('zoom-in').disabled).toBe(false);
    expect(button('zoom-out').disabled).toBe(true);
    expect(button('reset').disabled).toBe(true);
  });

  it('zooms around the center with the buttons, and resets', () => {
    button('zoom-in').click();
    expect(transform()).toEqual({ scale: 1.5, x: -100, y: -100 });
    expect(root().hasAttribute('data-zoomed')).toBe(true);
    expect(stage().style.touchAction).toBe('none');
    expect(button('reset').disabled).toBe(false);

    button('zoom-out').click();
    expect(transform().scale).toBe(1);

    button('zoom-in').click();
    button('reset').click();
    expect(transform()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('disables zoom-in at the limit', () => {
    for (let i = 0; i < 5; i++) button('zoom-in').click();
    expect(transform().scale).toBe(4);
    expect(button('zoom-in').disabled).toBe(true);
  });

  it('expands on a click and closes from the expand button', () => {
    stage().click();
    expect(root().hasAttribute('data-expanded')).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(button('expand').getAttribute('aria-pressed')).toBe('true');
    expect(button('expand').getAttribute('aria-label')).toBe('Close full view');
    expect(stage().style.touchAction).toBe('none');

    stage().click(); // already expanded: stays open
    expect(root().hasAttribute('data-expanded')).toBe(true);

    button('expand').click();
    expect(root().hasAttribute('data-expanded')).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    expect(button('expand').getAttribute('aria-label')).toBe('Open full view');
  });

  it('does not expand on a click while zoomed inline, or at the end of a drag', () => {
    button('zoom-in').click();
    stage().click();
    expect(root().hasAttribute('data-expanded')).toBe(false);

    button('reset').click();
    pointer('pointerdown', 1, 10, 10);
    pointer('pointermove', 1, 60, 10);
    pointer('pointerup', 1, 60, 10);
    stage().click();
    expect(root().hasAttribute('data-expanded')).toBe(false);

    // The drag flag is spent on that click; a clean click now expands.
    stage().click();
    expect(root().hasAttribute('data-expanded')).toBe(true);
  });

  it('still treats a press with a little jitter as a click', () => {
    pointer('pointerdown', 1, 10, 10);
    pointer('pointermove', 1, 12, 11);
    pointer('pointerup', 1, 12, 11);
    stage().click();
    expect(root().hasAttribute('data-expanded')).toBe(true);
  });

  it('toggles zoom at the cursor on double-click', () => {
    const event = new MouseEvent('dblclick', { cancelable: true, clientX: 100, clientY: 200 });
    stage().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(transform()).toEqual({ scale: 2.5, x: -150, y: -300 });

    stage().dispatchEvent(new MouseEvent('dblclick', { clientX: 100, clientY: 200 }));
    expect(transform().scale).toBe(1);
  });

  it('leaves the wheel to the page inline, and zooms with it in the full view', () => {
    const inline = wheel(-100);
    expect(inline.defaultPrevented).toBe(false);
    expect(transform().scale).toBe(1);

    button('expand').click();
    const expanded = wheel(-100);
    expect(expanded.defaultPrevented).toBe(true);
    expect(transform().scale).toBeCloseTo(Math.exp(0.2));

    wheel(-10, 1); // Firefox line mode: 10 lines = 160px
    expect(transform().scale).toBeCloseTo(Math.exp(0.2 + 0.32));
  });

  it('pans with a drag only while zoomed', () => {
    pointer('pointerdown', 1, 200, 200);
    pointer('pointermove', 1, 150, 200);
    expect(transform().x).toBe(0);
    pointer('pointerup', 1, 150, 200);

    button('zoom-in').click(); // x: -100, pannable range [-200, 0]
    pointer('pointerdown', 1, 200, 200);
    pointer('pointermove', 1, 150, 200);
    expect(transform().x).toBe(-150);
    pointer('pointermove', 1, 0, 200);
    expect(transform().x).toBe(-200); // clamped at the right edge
    pointer('pointercancel', 1, 0, 200);

    pointer('pointermove', 1, 100, 200); // no longer pressed
    expect(transform().x).toBe(-200);
  });

  it('pinch-zooms around the midpoint of two pointers', () => {
    pointer('pointerdown', 1, 150, 200);
    pointer('pointerdown', 2, 250, 200);
    pointer('pointermove', 2, 350, 200); // spread from 100px to 200px apart
    expect(transform().scale).toBe(2);

    // A third finger doesn't restart the pinch; its moves just pan.
    pointer('pointerdown', 3, 200, 300);
    pointer('pointermove', 3, 190, 300);
    expect(transform().scale).toBe(2);

    pointer('pointerup', 3, 190, 300);
    pointer('pointerup', 2, 350, 200);
    pointer('pointermove', 1, 140, 200); // back to one finger: a pan, not a pinch
    expect(transform().scale).toBe(2);
    pointer('pointerup', 1, 140, 200);
  });

  it('responds to the keyboard only in the full view', () => {
    expect(key('+').defaultPrevented).toBe(false);
    expect(transform().scale).toBe(1);

    button('expand').click();
    key('+');
    expect(transform().scale).toBe(1.5);
    key('=');
    expect(transform().scale).toBe(2.25);
    key('-');
    expect(transform().scale).toBe(1.5);

    const before = transform();
    expect(key('ArrowLeft').defaultPrevented).toBe(true);
    expect(transform().x).toBe(Math.min(0, before.x + 80));
    key('ArrowRight');
    key('ArrowUp');
    key('ArrowDown');
    expect(transform().y).toBe(before.y);

    expect(key('Tab').defaultPrevented).toBe(false);

    key('0');
    expect(transform().scale).toBe(1);

    key('Escape');
    expect(root().hasAttribute('data-expanded')).toBe(false);
  });

  it('re-fits on resize and once the image loads', () => {
    button('zoom-in').click();
    expect(transform().x).toBe(-100);
    // Widen the stage to 1000: the image now sits at x 100-900, 1200 wide at
    // 1.5x, so the old pan would expose a gap at the left edge.
    Object.defineProperty(stage(), 'clientWidth', { configurable: true, value: 1000 });
    window.dispatchEvent(new Event('resize'));
    expect(transform().x).toBe(-150);

    Object.defineProperty(image(), 'naturalWidth', { configurable: true, value: 8000 });
    image().dispatchEvent(new Event('load'));
    for (let i = 0; i < 6; i++) button('zoom-in').click();
    expect(transform().scale).toBeGreaterThan(4); // bigger source, higher limit
  });

  it('stops listening after teardown', () => {
    teardown();
    button('zoom-in').click();
    expect(transform().scale).toBe(1);
  });
});

describe('photo-viewer module', () => {
  it('returns a no-op teardown when the markup is incomplete', () => {
    document.body.innerHTML = '<figure data-photo-viewer></figure>';
    const stop = initPhotoViewer(q('[data-photo-viewer]'));
    expect(stop).not.toThrow();
  });

  it('initializes every viewer on the page when loaded', async () => {
    renderViewer();
    vi.resetModules();
    await import('../src/scripts/photo-viewer');
    expect(stage().style.touchAction).toBe('pan-y');
  });
});
