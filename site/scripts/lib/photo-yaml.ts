import { load } from 'js-yaml';
import type { BoundingBox } from '../../src/lib/bounding-box';

export type PhotoObjectEntry =
  | {
      boundingBox: BoundingBox | null;
      details: { description: string };
      objectType: 'landmark';
    }
  | {
      boundingBox: BoundingBox | null;
      details: {
        commonName: string;
        description: string | null;
        inaturalistObservationId: number | null;
        scientificName: string;
      };
      objectType: 'organism';
    };

/** A top-level YAML key starts at column 0; list items and nested keys are indented. */
const TOP_LEVEL_KEY = /^[a-z]/;

function renderBoundingBox(box: BoundingBox | null): string[] {
  if (!box) return ['  - boundingBox: null'];
  return [
    '  - boundingBox:',
    `      bottom: ${box.bottom}`,
    `      left: ${box.left}`,
    `      right: ${box.right}`,
    `      top: ${box.top}`,
  ];
}

function renderDescription(description: string | null): string {
  return `      description: ${description === null ? 'null' : JSON.stringify(description)}`;
}

/**
 * One `objects:` list item. The organism rendering is load-bearing beyond this
 * file: sync-inaturalist.ts:28 matches `commonName`/`description`/
 * `inaturalistObservationId`/`scientificName` as four consecutive 6-space
 * indented lines, so that shape must not drift.
 */
export function renderObject(entry: PhotoObjectEntry): string {
  const lines = [...renderBoundingBox(entry.boundingBox), '    details:'];
  if (entry.objectType === 'organism') {
    lines.push(
      `      commonName: ${JSON.stringify(entry.details.commonName)}`,
      // sync-inaturalist.ts captures and echoes this value back verbatim, so a
      // non-null description here round-trips through the nightly job.
      renderDescription(entry.details.description),
      `      inaturalistObservationId: ${entry.details.inaturalistObservationId ?? 'null'}`,
      `      scientificName: ${JSON.stringify(entry.details.scientificName)}`,
      '    objectType: organism'
    );
  } else {
    lines.push(`      description: ${JSON.stringify(entry.details.description)}`, '    objectType: landmark');
  }
  return lines.join('\n');
}

export function renderObjectsBlock(entries: PhotoObjectEntry[]): string {
  if (entries.length === 0) {
    return `objects:
  # - boundingBox: null
  #   details:
  #     commonName: ""
  #     description: null
  #     inaturalistObservationId: null
  #     scientificName: ""
  #   objectType: organism`;
  }
  return `objects:\n${entries.map(renderObject).join('\n')}`;
}

/**
 * Appends entries to the `objects:` block, leaving every other byte alone.
 * Published YAMLs are hand-edited (tier, notes, the `notes: # optional`
 * comment), so this splices text the way sync-inaturalist.ts does rather than
 * round-tripping through js-yaml, which would reformat the file and drop its
 * comments.
 */
export function appendObjects(text: string, entries: PhotoObjectEntry[]): string {
  if (entries.length === 0) return text;

  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'objects:');
  if (start === -1) throw new Error('Cannot append objects: no `objects:` block in photo YAML.');

  let end = start + 1;
  while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end])) end++;
  // Trailing blank lines belong after the block, not inside it.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;

  const body = lines.slice(start + 1, end);
  // A block holding only the commented-out scaffold is replaced, not added to.
  const onlyPlaceholder = body.length > 0 && body.every((line) => line.trim().startsWith('#'));

  return [
    ...lines.slice(0, start + 1),
    ...(onlyPlaceholder ? [] : body),
    ...entries.map(renderObject),
    ...lines.slice(end),
  ].join('\n');
}

/** Reads existing objects. Parsing with a real parser is free; only writing needs care. */
export function parsePhotoObjects(text: string): PhotoObjectEntry[] {
  const parsed = load(text) as { objects?: PhotoObjectEntry[] } | null | undefined;
  return parsed?.objects ?? [];
}
