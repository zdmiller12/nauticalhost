import { UNZOOMED, clampPan, containRect, maxScale, zoomAt, type Point, type ZoomState } from '../lib/zoom';

const ZOOM_STEP = 1.5;
const DOUBLE_CLICK_SCALE = 2.5;
const KEYBOARD_PAN = 80;
const WHEEL_SENSITIVITY = 0.002;
const DOM_DELTA_LINE = 1; // WheelEvent.deltaMode when deltaY is in lines (Firefox), not pixels
const LINE_HEIGHT_PX = 16;
// Pointer travel (px) past which a press counts as a drag rather than a click.
const DRAG_THRESHOLD = 4;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Wires up one `[data-photo-viewer]`: click to expand to the full window,
 * then zoom with the wheel, pinch, double-click, keyboard, or the buttons,
 * and drag to pan. Returns a teardown for the global listeners.
 */
export function initPhotoViewer(root: HTMLElement): () => void {
  const stage = root.querySelector<HTMLElement>('[data-viewer-stage]');
  const image = root.querySelector<HTMLImageElement>('[data-viewer-image]');
  const button = (action: string) => root.querySelector<HTMLButtonElement>(`[data-viewer-action="${action}"]`);
  const zoomInButton = button('zoom-in');
  const zoomOutButton = button('zoom-out');
  const resetButton = button('reset');
  const expandButton = button('expand');
  if (!stage || !image || !zoomInButton || !zoomOutButton || !resetButton || !expandButton) return () => {};

  const listeners = new AbortController();
  const { signal } = listeners;
  let state: ZoomState = UNZOOMED;
  let expanded = false;
  let dragged = false;
  let pressStart: Point = { x: 0, y: 0 };
  let pinch: { distance: number; scale: number } | null = null;
  const pointers = new Map<number, Point>();

  const box = () => ({ height: stage.clientHeight, width: stage.clientWidth });
  const natural = () => ({ height: image.naturalHeight, width: image.naturalWidth });
  const content = () => containRect(box(), natural());
  const limit = () => maxScale(content(), natural());
  const center = (): Point => ({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  const toStage = (event: { clientX: number; clientY: number }): Point => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const render = (next: ZoomState): void => {
    state = clampPan(next, box(), content());
    image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    const zoomed = state.scale > 1;
    root.toggleAttribute('data-zoomed', zoomed);
    // Unzoomed inline, let a vertical swipe scroll the page as usual.
    stage.style.touchAction = expanded || zoomed ? 'none' : 'pan-y';
    zoomInButton.disabled = state.scale >= limit();
    zoomOutButton.disabled = !zoomed;
    resetButton.disabled = !zoomed;
  };

  const zoomTo = (scale: number, point: Point = center()): void => render(zoomAt(state, scale, point, limit()));
  const panBy = (dx: number, dy: number): void => render({ ...state, x: state.x + dx, y: state.y + dy });

  const setExpanded = (value: boolean): void => {
    expanded = value;
    root.toggleAttribute('data-expanded', value);
    document.documentElement.style.overflow = value ? 'hidden' : '';
    expandButton.setAttribute('aria-pressed', String(value));
    expandButton.setAttribute('aria-label', value ? 'Close full view' : 'Open full view');
    // The stage just changed size, so any previous zoom no longer lines up.
    render(UNZOOMED);
    expandButton.focus();
  };

  zoomInButton.addEventListener('click', () => zoomTo(state.scale * ZOOM_STEP), { signal });
  zoomOutButton.addEventListener('click', () => zoomTo(state.scale / ZOOM_STEP), { signal });
  resetButton.addEventListener('click', () => render(UNZOOMED), { signal });
  expandButton.addEventListener('click', () => setExpanded(!expanded), { signal });

  stage.addEventListener(
    'click',
    () => {
      if (!expanded && !dragged && state.scale === 1) setExpanded(true);
      dragged = false;
    },
    { signal },
  );

  stage.addEventListener(
    'dblclick',
    (event) => {
      event.preventDefault();
      if (state.scale > 1) render(UNZOOMED);
      else zoomTo(DOUBLE_CLICK_SCALE, toStage(event));
    },
    { signal },
  );

  stage.addEventListener(
    'wheel',
    (event) => {
      // Inline, the wheel scrolls the page; only the full view hijacks it.
      if (!expanded) return;
      event.preventDefault();
      const delta = event.deltaMode === DOM_DELTA_LINE ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
      zoomTo(state.scale * Math.exp(-delta * WHEEL_SENSITIVITY), toStage(event));
    },
    { passive: false, signal },
  );

  stage.addEventListener(
    'pointerdown',
    (event) => {
      const point = toStage(event);
      pointers.set(event.pointerId, point);
      stage.setPointerCapture(event.pointerId);
      if (pointers.size === 1) {
        pressStart = point;
        dragged = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { distance: distance(a, b), scale: state.scale };
      }
    },
    { signal },
  );

  stage.addEventListener(
    'pointermove',
    (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const point = toStage(event);
      pointers.set(event.pointerId, point);
      if (distance(pressStart, point) > DRAG_THRESHOLD) dragged = true;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        zoomTo(pinch.scale * (distance(a, b) / pinch.distance), midpoint(a, b));
      } else if (state.scale > 1) {
        panBy(point.x - previous.x, point.y - previous.y);
      }
    },
    { signal },
  );

  const release = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  stage.addEventListener('pointerup', release, { signal });
  stage.addEventListener('pointercancel', release, { signal });

  // Capture phase, so the photo page's arrow-key navigation (which checks
  // defaultPrevented) never sees keys the full view has claimed.
  const keyActions: Record<string, () => void> = {
    '+': () => zoomTo(state.scale * ZOOM_STEP),
    '=': () => zoomTo(state.scale * ZOOM_STEP),
    '-': () => zoomTo(state.scale / ZOOM_STEP),
    '0': () => render(UNZOOMED),
    ArrowDown: () => panBy(0, -KEYBOARD_PAN),
    ArrowLeft: () => panBy(KEYBOARD_PAN, 0),
    ArrowRight: () => panBy(-KEYBOARD_PAN, 0),
    ArrowUp: () => panBy(0, KEYBOARD_PAN),
    Escape: () => setExpanded(false),
  };
  window.addEventListener(
    'keydown',
    (event) => {
      const action = keyActions[event.key];
      if (!expanded || !action) return;
      event.preventDefault();
      action();
    },
    { capture: true, signal },
  );

  window.addEventListener('resize', () => render(state), { signal });
  image.addEventListener('load', () => render(state), { signal });

  render(UNZOOMED);
  return () => listeners.abort();
}

for (const root of document.querySelectorAll<HTMLElement>('[data-photo-viewer]')) {
  initPhotoViewer(root);
}
