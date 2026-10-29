import { intersectionOverUnion, type BoundingBox } from '../../src/lib/bounding-box';
import { parsePhotoObjects, type PhotoObjectEntry } from './photo-yaml';
import type { ObjectInput } from './publish';
import type { PhotoExif } from './exif';

/** One photo the caller wants boxes for, before the queue is built. */
export interface QueueSource {
  exif: PhotoExif;
  /** The photo's current YAML, or null when it has not been published yet. */
  existingYaml: string | null;
  /** An explicit coordinate (e.g. a CSV `lat`/`lon` column or a `--lat`/`--lon` flag) that prefills the dialog ahead of EXIF GPS. Omitted (not null) when the caller has none to offer. */
  latitude?: number | null;
  longitude?: number | null;
  /** Objects already known for this photo (e.g. a CSV `species` column) before any box is drawn, seeded as editable drafts. */
  objects?: ObjectInput[];
  slug: string;
  sourcePath: string;
}

/** One photo as the dialog sees it. Serialised straight into the page. */
export interface QueuePhoto {
  /** Objects already published for this photo; rendered read-only. */
  existingObjects: PhotoObjectEntry[];
  /** Position in the queue. Addresses `GET /photo/:index` and keys the posted payload. */
  index: number;
  latitude: number | null;
  longitude: number | null;
  /** Objects already known before the dialog opened; seeded as editable drafts (a null box gets a default one to adjust). */
  objects: ObjectInput[];
  slug: string;
  sourcePath: string;
}

export function buildQueue(sources: QueueSource[]): QueuePhoto[] {
  return sources.map((source, index) => ({
    existingObjects: source.existingYaml === null ? [] : parsePhotoObjects(source.existingYaml),
    index,
    latitude: source.latitude ?? source.exif.latitude,
    longitude: source.longitude ?? source.exif.longitude,
    objects: source.objects ?? [],
    slug: source.slug,
    sourcePath: source.sourcePath,
  }));
}

/**
 * Above this IoU, two boxes are treated as the same region. 0.7 is loose
 * enough that a hand-redrawn box over the same bird trips it, and tight
 * enough that two gulls standing side by side do not.
 */
export const DUPLICATE_IOU_THRESHOLD = 0.7;

/** Why a candidate object looks like one already on the photo. */
export interface DuplicateWarning {
  /** Index into the photo's `existingObjects`. */
  existingIndex: number;
  reason: 'details' | 'overlap';
}

const normalizeName = (value: string): string => value.trim().toLowerCase();

/** The identifying text of an object: the species for an organism, the description for a landmark. */
function identity(entry: ObjectInput | PhotoObjectEntry): string {
  if (entry.objectType === 'landmark') {
    return normalizeName('details' in entry ? entry.details.description : entry.description);
  }
  return normalizeName('details' in entry ? entry.details.scientificName : entry.scientificName);
}

/**
 * Flags a candidate object that is probably already on the photo -- either by
 * identifying text or by sitting on top of an existing box. Advisory only: the
 * caller decides whether to warn or to proceed. Matching never crosses object
 * types, since a landmark named after a species is not a duplicate of it.
 */
export function findDuplicates(existing: PhotoObjectEntry[], candidate: ObjectInput): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = [];
  const candidateIdentity = identity(candidate);
  existing.forEach((entry, existingIndex) => {
    if (entry.objectType !== candidate.objectType) return;
    if (candidateIdentity !== '' && identity(entry) === candidateIdentity) {
      warnings.push({ existingIndex, reason: 'details' });
      return;
    }
    if (
      entry.boundingBox &&
      candidate.boundingBox &&
      intersectionOverUnion(entry.boundingBox, candidate.boundingBox) > DUPLICATE_IOU_THRESHOLD
    ) {
      warnings.push({ existingIndex, reason: 'overlap' });
    }
  });
  return warnings;
}

/** One photo's worth of accepted input, ready to become `PublishArgs`. */
export interface AcceptedPhoto {
  index: number;
  latitude: number | null;
  longitude: number | null;
  objects: ObjectInput[];
  slug: string;
  sourcePath: string;
}

/** A duplicate warning located within the whole posted payload. */
export interface PostedDuplicate extends DuplicateWarning {
  /** Index into the posted photo's `objects`. */
  candidateIndex: number;
  /** `QueuePhoto.index` of the photo it was posted for. */
  photoIndex: number;
}

export type ValidationOutcome =
  | { duplicates: PostedDuplicate[] }
  | { errors: string[] }
  | { photos: AcceptedPhoto[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Validates one posted box. Returns the box, null for "no box", or an error fragment. */
function readBox(raw: unknown): { box: BoundingBox | null } | { error: string } {
  if (raw === null || raw === undefined) return { box: null };
  if (!isRecord(raw)) return { error: 'box must be an object or null.' };
  const edges = [raw.bottom, raw.left, raw.right, raw.top];
  if (edges.some((edge) => typeof edge !== 'number' || Number.isNaN(edge))) {
    return { error: 'box edges must be numbers.' };
  }
  const [bottom, left, right, top] = edges as number[];
  if (edges.some((edge) => (edge as number) < 0 || (edge as number) > 1)) {
    return { error: 'box edges are fractions and must be within 0..1.' };
  }
  if (right <= left || bottom <= top) {
    return { error: 'box must have positive area (left<right, top<bottom).' };
  }
  return { box: { bottom, left, right, top } };
}

/** Validates one posted object. Returns the ObjectInput or an error fragment. */
function readObject(raw: unknown): { object: ObjectInput } | { error: string } {
  if (!isRecord(raw)) return { error: 'expected an object.' };
  const parsedBox = readBox(raw.boundingBox);
  if ('error' in parsedBox) return parsedBox;
  if (raw.objectType === 'landmark') {
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description === '') return { error: 'a landmark needs a description.' };
    return { object: { boundingBox: parsedBox.box, description, objectType: 'landmark' } };
  }
  if (raw.objectType === 'organism') {
    const scientificName = typeof raw.scientificName === 'string' ? raw.scientificName.trim() : '';
    if (scientificName === '') return { error: 'an organism needs a scientific name.' };
    const described = typeof raw.description === 'string' ? raw.description.trim() : '';
    return {
      object: {
        boundingBox: parsedBox.box,
        description: described === '' ? null : described,
        objectType: 'organism',
        scientificName,
      },
    };
  }
  return { error: 'objectType must be "organism" or "landmark".' };
}

/** Validates one posted coordinate pair. Both or neither. */
function readCoordinates(
  raw: Record<string, unknown>
): { latitude: number | null; longitude: number | null } | { error: string } {
  // Trimmed, because `Number(' ')` is 0, not NaN: a field left holding a stray
  // space after a select-all-and-retype would otherwise publish at 0,0.
  const blank = (value: unknown) => value === null || value === undefined || String(value).trim() === '';
  if (blank(raw.latitude) !== blank(raw.longitude)) {
    return { error: 'latitude and longitude must both be set or both be blank.' };
  }
  if (blank(raw.latitude)) return { latitude: null, longitude: null };
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return { error: 'latitude and longitude must be numbers.' };
  }
  return { latitude, longitude };
}

/**
 * Validates the browser's payload against the queue it was issued for.
 *
 * Errors win over duplicates: "add anyway" is an answer to "is this the same
 * bird", not to "is this box inside the image". A `force: true` photo skips
 * its own duplicate check but is still fully validated.
 */
export function validatePosted(posted: unknown, queue: QueuePhoto[]): ValidationOutcome {
  if (!isRecord(posted) || !Array.isArray(posted.photos)) {
    return { errors: ['Expected a payload with a "photos" array.'] };
  }

  const errors: string[] = [];
  const duplicates: PostedDuplicate[] = [];
  const photos: AcceptedPhoto[] = [];

  for (const rawPhoto of posted.photos) {
    if (!isRecord(rawPhoto)) {
      errors.push('Expected each entry of "photos" to be an object.');
      continue;
    }
    const queued = queue.find((photo) => photo.index === rawPhoto.index);
    if (!queued) {
      errors.push(`Photo ${String(rawPhoto.index)} is not in this dialog session.`);
      continue;
    }

    const coordinates = readCoordinates(rawPhoto);
    if ('error' in coordinates) {
      errors.push(`${queued.slug}: ${coordinates.error}`);
      continue;
    }

    const rawObjects = Array.isArray(rawPhoto.objects) ? rawPhoto.objects : [];
    const objects: ObjectInput[] = [];
    rawObjects.forEach((rawObject, candidateIndex) => {
      const parsed = readObject(rawObject);
      if ('error' in parsed) {
        errors.push(`${queued.slug} object ${candidateIndex + 1}: ${parsed.error}`);
        return;
      }
      objects.push(parsed.object);
      if (rawPhoto.force === true) return;
      for (const warning of findDuplicates(queued.existingObjects, parsed.object)) {
        duplicates.push({ ...warning, candidateIndex, photoIndex: queued.index });
      }
    });

    photos.push({
      index: queued.index,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      objects,
      slug: queued.slug,
      sourcePath: queued.sourcePath,
    });
  }

  if (errors.length > 0) return { errors };
  if (duplicates.length > 0) return { duplicates };
  return { photos };
}
