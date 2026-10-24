// This module is shipped straight to the browser by dialog-server.ts via
// `esbuild.transform()`, which does NOT bundle: it only strips types and
// lowers syntax. Any runtime `import` here would reach the browser as an
// unresolvable bare specifier -- a failure a happy-dom test cannot see,
// which is why tests/shared-purity.test.ts reads this file's source text
// instead of importing it, and why only `import type` is permitted below.

import type { BoundingBox } from '../../src/lib/bounding-box';
import type { PostedDuplicate, QueuePhoto } from './dialog-session';

/** Distinct enough to tell apart at a glance, and legible on both light and dark photos. */
const COLOURS = ['#ff6b6b', '#7fd1ff', '#ffd166', '#95e06c', '#c792ea', '#ff9f68'];

/** Below this many pixels on either axis, a drag was a click. */
const MIN_DRAG_PX = 4;

/** What the inline bootstrap script in renderPage() hands to initDialog. */
export interface DialogClientDeps {
  /**
   * The element's position and size in client pixels. Injected because
   * happy-dom reports an all-zero rect, which would make a test unable to
   * tell a correct normalization from a broken one.
   */
  rect: (element: Element) => { height: number; left: number; top: number; width: number };
  /** The subset of `fetch`/`Response` this module uses, so the real `fetch` satisfies it. */
  send: (path: string, payload: unknown) => Promise<{ json: () => Promise<unknown>; status: number }>;
}

/** One object the user is describing for the current photo. `box` is null for "no box". */
interface Draft {
  box: BoundingBox | null;
  description: string;
  objectType: 'landmark' | 'organism';
  scientificName: string;
}

/** Everything entered for one queued photo. Kept per photo so walking the queue preserves work. */
interface PhotoDraft {
  drafts: Draft[];
  /** The raw field text: `validatePosted` owns coercion, so the client never parses it. */
  latitude: string;
  longitude: string;
}

type Point = { x: number; y: number };

/**
 * Wires up the dialog page rendered by `renderPage`: drag on the overlay to
 * draw a normalized box, label it in the row list, reorder (the first box is
 * the photo's thumbnail), delete, walk the queue, and post the result.
 *
 * State lives in a closure over one `PhotoDraft` per queued photo, and a
 * single `render()` rewrites the stage, the overlay, the rows and the
 * existing list from it. Re-rendering wholesale rather than patching is what
 * keeps row order, swatch colour and box colour in agreement after a reorder
 * or a delete.
 */
export function initDialog(root: HTMLElement, deps: DialogClientDeps): void {
  const find = <T extends Element>(selector: string, scope: ParentNode = root): T =>
    scope.querySelector<T>(selector)!;
  const field = <T extends Element = HTMLInputElement>(name: string, scope: ParentNode = root): T =>
    find<T>(`[data-dialog-field="${name}"]`, scope);
  const button = (name: string, scope: ParentNode = root): HTMLButtonElement =>
    find<HTMLButtonElement>(`[data-dialog-action="${name}"]`, scope);

  const queue = JSON.parse(find('[data-dialog-queue]').textContent!) as QueuePhoto[];
  const stage = find<HTMLElement>('[data-dialog-stage]');
  const overlay = find<HTMLElement>('[data-dialog-overlay]');
  const image = find<HTMLImageElement>('[data-dialog-image]');
  const latitudeField = field('latitude');
  const longitudeField = field('longitude');
  const rowList = find<HTMLElement>('[data-dialog-rows]');
  const existingList = find<HTMLElement>('[data-dialog-existing]');
  const warnings = find<HTMLElement>('[data-dialog-warnings]');
  const position = find<HTMLElement>('[data-dialog-position]');
  const rowTemplate = find<HTMLElement>(
    '[data-dialog-row]',
    find<HTMLTemplateElement>('[data-dialog-row-template]').content
  );

  const photos: PhotoDraft[] = queue.map((photo) => ({
    drafts: [],
    latitude: String(photo.latitude ?? ''),
    longitude: String(photo.longitude ?? ''),
  }));
  let current = 0;
  const entry = (): PhotoDraft => photos[current];

  const point = (event: { clientX: number; clientY: number }): Point => ({ x: event.clientX, y: event.clientY });

  /** The ordered, clamped box two client points span, so a drag in any direction works. */
  const edges = (from: Point, to: Point): BoundingBox => {
    const area = deps.rect(stage);
    const horizontal = (value: number) => Math.min(1, Math.max(0, (value - area.left) / area.width));
    const vertical = (value: number) => Math.min(1, Math.max(0, (value - area.top) / area.height));
    return {
      bottom: vertical(Math.max(from.y, to.y)),
      left: horizontal(Math.min(from.x, to.x)),
      right: horizontal(Math.max(from.x, to.x)),
      top: vertical(Math.min(from.y, to.y)),
    };
  };

  /** The drawn box, or null when the pointer barely moved -- that was a click. */
  const normalize = (from: Point, to: Point): BoundingBox | null => {
    const area = deps.rect(stage);
    const box = edges(from, to);
    const smallest = Math.min((box.right - box.left) * area.width, (box.bottom - box.top) * area.height);
    if (smallest < MIN_DRAG_PX) return null;
    return box;
  };

  /** Positions a box element in stage pixels; the overlay is never CSS-transformed. */
  const place = (element: HTMLElement, box: BoundingBox) => {
    const area = deps.rect(stage);
    element.style.height = `${(box.bottom - box.top) * area.height}px`;
    element.style.left = `${box.left * area.width}px`;
    element.style.top = `${box.top * area.height}px`;
    element.style.width = `${(box.right - box.left) * area.width}px`;
  };

  /** Lights up the row and the box that share an index, in either direction. */
  const highlight = (index: number) => {
    root.querySelectorAll<HTMLElement>('[data-dialog-row], [data-dialog-box]').forEach((element) => {
      element.dataset.active = String(element.dataset.index === String(index));
    });
  };

  /** Reads the live inputs back into state, so a re-render never loses typing. */
  const sync = () => {
    entry().latitude = latitudeField.value;
    entry().longitude = longitudeField.value;
    rowList.querySelectorAll<HTMLElement>('[data-dialog-row]').forEach((row, index) => {
      const draft = entry().drafts[index];
      draft.description = field('description', row).value;
      draft.objectType = field<HTMLSelectElement>('objectType', row).value as Draft['objectType'];
      draft.scientificName = field('scientificName', row).value;
    });
  };

  /** An already-published object, shown read-only: no inputs, nothing to edit. */
  const describeExisting = (object: QueuePhoto['existingObjects'][number]): string => {
    // Every text detail, whichever object type it is: the published entry is
    // only ever read here, so there is nothing to gain from naming the fields.
    const details = Object.values(object.details as Record<string, unknown>);
    return [object.objectType, ...details.filter((value) => typeof value === 'string')].join(' — ');
  };

  const render = () => {
    const photo = queue[current];
    image.setAttribute('src', `/photo/${photo.index}`);
    position.textContent = `${photo.slug} — ${current + 1} of ${queue.length}`;
    button('prev').disabled = current === 0;
    button('next').disabled = current === queue.length - 1;

    latitudeField.value = entry().latitude;
    latitudeField.placeholder = photo.latitude === null ? 'No GPS in EXIF' : 'Latitude';
    longitudeField.value = entry().longitude;
    longitudeField.placeholder = photo.longitude === null ? 'No GPS in EXIF' : 'Longitude';

    overlay.textContent = '';
    rowList.textContent = '';
    entry().drafts.forEach((draft, index) => {
      const colour = COLOURS[index % COLOURS.length];

      if (draft.box) {
        const element = document.createElement('div');
        element.dataset.dialogBox = '';
        element.dataset.box = JSON.stringify(draft.box);
        element.dataset.index = String(index);
        element.style.borderColor = colour;
        place(element, draft.box);
        const label = document.createElement('span');
        label.style.background = colour;
        label.textContent = String(index + 1);
        element.append(label);
        element.addEventListener('pointerenter', () => highlight(index));
        overlay.append(element);
      }

      const row = rowTemplate.cloneNode(true) as HTMLElement;
      row.dataset.index = String(index);
      find<HTMLElement>('[data-dialog-swatch]', row).style.background = colour;
      const type = field<HTMLSelectElement>('objectType', row);
      type.value = draft.objectType;
      const scientificName = field('scientificName', row);
      scientificName.value = draft.scientificName;
      // A landmark is identified by its description; a species name would be noise.
      scientificName.hidden = draft.objectType === 'landmark';
      field('description', row).value = draft.description;
      type.addEventListener('change', () => {
        sync();
        render();
      });
      button('up', row).addEventListener('click', () => move(index, -1));
      button('down', row).addEventListener('click', () => move(index, 1));
      button('delete', row).addEventListener('click', () => {
        sync();
        entry().drafts.splice(index, 1);
        render();
      });
      row.addEventListener('pointerenter', () => highlight(index));
      rowList.append(row);
    });

    existingList.textContent = '';
    photo.existingObjects.forEach((object) => {
      const item = document.createElement('li');
      item.textContent = describeExisting(object);
      existingList.append(item);
    });
  };

  /** Reorders one row. The target is clamped, so moving an end row is a no-op. */
  const move = (index: number, delta: number) => {
    sync();
    const drafts = entry().drafts;
    const target = Math.min(drafts.length - 1, Math.max(0, index + delta));
    drafts.splice(target, 0, ...drafts.splice(index, 1));
    render();
  };

  /** Walks the queue, clamped to its ends. */
  const go = (delta: number) => {
    sync();
    current = Math.min(queue.length - 1, Math.max(0, current + delta));
    render();
  };

  const warn = (text: string) => {
    const line = document.createElement('p');
    line.textContent = text;
    warnings.append(line);
  };

  const describeDuplicate = (duplicate: PostedDuplicate): string =>
    `${queue[duplicate.photoIndex].slug}: object ${duplicate.candidateIndex + 1} looks like published object ${
      duplicate.existingIndex + 1
    } (${duplicate.reason}).`;

  /**
   * Posts every photo. A 400 or a 409 leaves the page exactly as it is -- the
   * drawn boxes are the user's work, and both answers are recoverable; a 200
   * means the server has the result and is closing the dialog.
   */
  const submit = async (force: boolean) => {
    sync();
    warnings.textContent = '';
    const response = await deps.send('/result', {
      photos: photos.map((photo, index) => ({
        force,
        index: queue[index].index,
        latitude: photo.latitude,
        longitude: photo.longitude,
        objects: photo.drafts.map((draft) => ({
          boundingBox: draft.box,
          description: draft.description,
          objectType: draft.objectType,
          scientificName: draft.scientificName,
        })),
      })),
    });
    const body = (await response.json()) as { duplicates: PostedDuplicate[]; errors: string[] };
    if (response.status === 400) {
      body.errors.forEach((error) => warn(error));
      return;
    }
    if (response.status === 409) {
      body.duplicates.forEach((duplicate) => warn(describeDuplicate(duplicate)));
      const anyway = document.createElement('button');
      anyway.dataset.dialogAction = 'force';
      anyway.textContent = 'Add anyway';
      anyway.type = 'button';
      anyway.addEventListener('click', () => void submit(true));
      warnings.append(anyway);
    }
  };

  overlay.addEventListener('pointerdown', (event) => {
    const from = point(event);
    // The move/up pair is scoped to this one drag, which is also why neither
    // needs to ask whether a drag is in progress.
    const drag = new AbortController();
    const preview = document.createElement('div');
    preview.dataset.dialogPreview = '';
    preview.style.border = '2px dashed #e8edf2';
    preview.style.boxSizing = 'border-box';
    preview.style.position = 'absolute';
    overlay.append(preview);
    overlay.addEventListener(
      'pointermove',
      (moved) => place(preview, edges(from, point(moved))),
      { signal: drag.signal }
    );
    overlay.addEventListener(
      'pointerup',
      (released) => {
        drag.abort();
        preview.remove();
        const box = normalize(from, point(released));
        if (box) {
          sync();
          entry().drafts.push({ box, description: '', objectType: 'organism', scientificName: '' });
          render();
        }
      },
      { once: true, signal: drag.signal }
    );
  });

  button('add').addEventListener('click', () => {
    sync();
    entry().drafts.push({ box: null, description: '', objectType: 'organism', scientificName: '' });
    render();
  });
  button('prev').addEventListener('click', () => go(-1));
  button('next').addEventListener('click', () => go(1));
  button('submit').addEventListener('click', () => void submit(false));
  button('cancel').addEventListener('click', () => void deps.send('/cancel', {}));

  render();
}
