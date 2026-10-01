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
