// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { initDialog } from '../scripts/lib/dialog-client';
import { renderPage } from '../scripts/lib/dialog-server';
import { buildQueue, type QueueSource } from '../scripts/lib/dialog-session';
import type { PhotoExif } from '../scripts/lib/exif';

const exif = (latitude: number | null, longitude: number | null): PhotoExif => ({
  camera: null,
  date: null,
  latitude,
  lens: null,
  longitude,
  other: {},
  utcOffsetMinutes: null,
});

const source = (overrides: Partial<QueueSource> = {}): QueueSource => ({
  exif: exif(44.1, -68.2),
  existingYaml: null,
  slug: 'DSC_0001',
  sourcePath: 'photos/a.JPG',
  ...overrides,
});

// A 400x200 stage anchored at the origin, so client coords are stage coords
// and a drag from (40,20) to (200,120) normalizes to 0.1,0.1 -> 0.5,0.6.
const STAGE = { height: 200, left: 0, top: 0, width: 400 };

function mount(sources: QueueSource[] = [source()], send = vi.fn(async () => ({ json: async () => ({}), status: 200 }))) {
  // renderPage is the real markup contract -- testing against a hand-written
  // fixture would let the two drift silently. The body is re-parsed through
  // documentElement rather than `document.body.outerHTML`, which in happy-dom
  // detaches the body and leaves `document.body` null for the next mount.
  document.documentElement.innerHTML = renderPage(buildQueue(sources)).match(/<body[\s\S]*<\/body>/)![0];
  const root = document.querySelector<HTMLElement>('[data-dialog]')!;
  initDialog(root, { rect: () => STAGE, send });
  return { root, send };
}

const q = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;
const all = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)];
const stage = () => q<HTMLElement>('[data-dialog-stage]');
const rows = () => all<HTMLElement>('[data-dialog-row]');
const action = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLButtonElement>(`[data-dialog-action="${name}"]`)!;

const drag = (fromX: number, fromY: number, toX: number, toY: number) => {
  const target = q<HTMLElement>('[data-dialog-overlay]');
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: fromX, clientY: fromY, pointerId: 1 }));
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: toX, clientY: toY, pointerId: 1 }));
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: toX, clientY: toY, pointerId: 1 }));
};

describe('initDialog', () => {
  it('shows the first photo and prefills its EXIF coordinates', () => {
    mount();
    expect(q<HTMLImageElement>('[data-dialog-image]').getAttribute('src')).toBe('/photo/0');
    expect(q<HTMLInputElement>('[data-dialog-field="latitude"]').value).toBe('44.1');
    expect(q<HTMLInputElement>('[data-dialog-field="longitude"]').value).toBe('-68.2');
  });

  it('flags absent coordinates instead of leaving the field silently empty', () => {
    mount([source({ exif: exif(null, null) })]);
    expect(q<HTMLInputElement>('[data-dialog-field="latitude"]').placeholder).toMatch(/no gps/i);
  });

  it('draws a normalized box from a drag', () => {
    mount();
    drag(40, 20, 200, 120);
    expect(rows()).toHaveLength(1);
    const box = JSON.parse(q<HTMLElement>('[data-dialog-box]').dataset.box!);
    expect(box).toEqual({ bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 });
  });

  it('normalizes a drag made in any direction', () => {
    mount();
    drag(200, 120, 40, 20);
    const box = JSON.parse(q<HTMLElement>('[data-dialog-box]').dataset.box!);
    expect(box).toEqual({ bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 });
  });

  it('ignores a click that draws no area', () => {
    mount();
    drag(40, 20, 41, 20);
    expect(rows()).toHaveLength(0);
  });

  it('gives each box a distinct colour matching its row swatch', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    const boxes = all<HTMLElement>('[data-dialog-box]');
    const swatches = all<HTMLElement>('[data-dialog-swatch]');
    expect(boxes[0].style.borderColor).not.toBe(boxes[1].style.borderColor);
    expect(swatches[0].style.background).toBe(boxes[0].style.borderColor);
  });

  it('highlights the matching box when a row is hovered, and the reverse', () => {
    mount();
    drag(40, 20, 200, 120);
    rows()[0].dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    expect(q<HTMLElement>('[data-dialog-box]').dataset.active).toBe('true');
    q<HTMLElement>('[data-dialog-box]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    expect(rows()[0].dataset.active).toBe('true');
  });

  it('clears the highlight when the pointer leaves a row or a box', () => {
    mount();
    drag(40, 20, 200, 120);
    // Not bubbling, because a user agent's pointerleave never is: a listener
    // on the overlay or the row list would not see these.
    rows()[0].dispatchEvent(new PointerEvent('pointerenter'));
    rows()[0].dispatchEvent(new PointerEvent('pointerleave'));
    expect(q<HTMLElement>('[data-dialog-box]').dataset.active).not.toBe('true');
    q<HTMLElement>('[data-dialog-box]').dispatchEvent(new PointerEvent('pointerenter'));
    q<HTMLElement>('[data-dialog-box]').dispatchEvent(new PointerEvent('pointerleave'));
    expect(rows()[0].dataset.active).not.toBe('true');
  });

  it('keeps the highlight when the pointer moves straight from one box to the next', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    const boxes = all<HTMLElement>('[data-dialog-box]');
    // The real order: leave the first, then enter the second.
    boxes[0].dispatchEvent(new PointerEvent('pointerenter'));
    boxes[0].dispatchEvent(new PointerEvent('pointerleave'));
    boxes[1].dispatchEvent(new PointerEvent('pointerenter'));
    expect(boxes[1].dataset.active).toBe('true');
    expect(rows()[1].dataset.active).toBe('true');
    expect(boxes[0].dataset.active).not.toBe('true');
  });

  it('switches a row between organism and landmark fields', () => {
    mount();
    drag(40, 20, 200, 120);
    const select = rows()[0].querySelector<HTMLSelectElement>('[data-dialog-field="objectType"]')!;
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.hidden).toBe(false);
    select.value = 'landmark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.hidden).toBe(true);
  });

  it('reorders rows, and the first row is the primary box', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    rows()[1].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value = 'Larus argentatus';
    action('up', rows()[1]).click();
    expect(rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value).toBe(
      'Larus argentatus'
    );
  });

  it('moves a row down', () => {
    mount();
    drag(40, 20, 200, 120);
    drag(210, 20, 380, 120);
    rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value = 'Larus argentatus';
    action('down', rows()[0]).click();
    expect(rows()[1].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value).toBe(
      'Larus argentatus'
    );
  });

  it('deletes a row and its box together', () => {
    mount();
    drag(40, 20, 200, 120);
    action('delete', rows()[0]).click();
    expect(rows()).toHaveLength(0);
    expect(all('[data-dialog-box]')).toHaveLength(0);
  });

  it('adds an object with no box', () => {
    mount();
    action('add').click();
    expect(rows()).toHaveLength(1);
    expect(all('[data-dialog-box]')).toHaveLength(0);
  });

  it('renders already-published objects read-only', () => {
    const existingYaml = [
      'objects:',
      '  - boundingBox: null',
      '    details:',
      '      commonName: "Herring Gull"',
      '      description: null',
      '      inaturalistObservationId: 7',
      '      scientificName: "Larus argentatus"',
      '    objectType: organism',
      '',
    ].join('\n');
    mount([source({ existingYaml })]);
    expect(q<HTMLElement>('[data-dialog-existing]').textContent).toContain('Larus argentatus');
    expect(all('[data-dialog-existing] input')).toHaveLength(0);
  });

  it("walks between photos, keeping each photo's rows", () => {
    mount([source({ slug: 'a' }), source({ slug: 'b' })]);
    drag(40, 20, 200, 120);
    action('next').click();
    expect(q<HTMLImageElement>('[data-dialog-image]').getAttribute('src')).toBe('/photo/1');
    expect(rows()).toHaveLength(0);
    action('prev').click();
    expect(rows()).toHaveLength(1);
  });

  it('does not walk past either end of the queue', () => {
    mount();
    expect(action('prev').disabled).toBe(true);
    expect(action('next').disabled).toBe(true);
    expect(q('[data-dialog-position]').textContent).toContain('1');
  });

  it('posts every photo on submit', async () => {
    const { send } = mount();
    drag(40, 20, 200, 120);
    rows()[0].querySelector<HTMLInputElement>('[data-dialog-field="scientificName"]')!.value = 'Larus argentatus';
    action('submit').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith('/result', {
      photos: [
        {
          force: false,
          index: 0,
          latitude: '44.1',
          longitude: '-68.2',
          objects: [
            {
              boundingBox: { bottom: 0.6, left: 0.1, right: 0.5, top: 0.1 },
              description: '',
              objectType: 'organism',
              scientificName: 'Larus argentatus',
            },
          ],
        },
      ],
    });
  });

  it('shows server-side validation errors without losing the drawn boxes', async () => {
    const send = vi.fn(async () => ({ json: async () => ({ errors: ['DSC_0001 object 1: boom'] }), status: 400 }));
    mount([source()], send);
    drag(40, 20, 200, 120);
    action('submit').click();
    await vi.waitFor(() => expect(q('[data-dialog-warnings]').textContent).toContain('boom'));
    expect(rows()).toHaveLength(1);
  });

  it('offers "add anyway" on a duplicate and resubmits with force', async () => {
    const duplicates = [{ candidateIndex: 0, existingIndex: 0, photoIndex: 0, reason: 'details' }];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ duplicates }), status: 409 })
      .mockResolvedValueOnce({ json: async () => ({ ok: true }), status: 200 });
    mount([source()], send);
    drag(40, 20, 200, 120);
    action('submit').click();
    await vi.waitFor(() => expect(action('force')).toBeTruthy());
    action('force').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1].photos[0].force).toBe(true);
  });

  it('posts a cancel', async () => {
    const { send } = mount();
    action('cancel').click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('/cancel', {}));
  });
});
