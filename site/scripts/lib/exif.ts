import exifr from 'exifr';

export type ExifScalar = string | number | boolean;

export interface PhotoExif {
  camera: string | null;
  date: Date | null;
  latitude: number | null;
  lens: string | null;
  longitude: number | null;
  other: Record<string, ExifScalar>;
  utcOffsetMinutes: number | null;
}

// Tags already surfaced as their own typed field above — excluded from
// `other` so the same value never appears twice.
const TYPED_TAGS = new Set([
  'DateTimeOriginal',
  'LensModel',
  'Make',
  'Model',
  'OffsetTimeOriginal',
  'latitude',
  'longitude',
]);

// Tags that identify the specific camera/lens/photographer (serials, owner
// info) or are otherwise never useful — dropped rather than written into a
// published, world-readable photo page.
const OTHER_DENYLIST = new Set([
  'BodySerialNumber',
  'CameraOwnerName',
  'ImageUniqueID',
  'InternalSerialNumber',
  'LensSerialNumber',
  'MakerNote',
  'OwnerName',
  'SerialNumber',
  'UserComment',
]);

function isExifScalar(value: unknown): value is ExifScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Everything exifr found that isn't one of the typed fields above, isn't
 * denylisted, and is representable as a plain scalar (binary data like an
 * embedded thumbnail, or nested objects/arrays, is dropped rather than
 * forced into a shape that doesn't serialize sensibly into YAML).
 */
function buildOther(data: Record<string, unknown>): Record<string, ExifScalar> {
  const other: Record<string, ExifScalar> = {};
  for (const [key, value] of Object.entries(data)) {
    if (TYPED_TAGS.has(key) || OTHER_DENYLIST.has(key)) continue;
    if (value instanceof Date) {
      other[key] = value.toISOString();
    } else if (isExifScalar(value)) {
      other[key] = value;
    }
  }
  return other;
}

/**
 * Parses EXIF's "±HH:MM" UTC offset tags (e.g. OffsetTimeOriginal) into
 * signed total minutes (local time is this many minutes ahead of UTC).
 * Returns null for anything missing or not in that exact shape, rather
 * than throwing — not every camera writes this tag, and we treat an
 * unparseable value the same as an absent one.
 */
function parseUtcOffsetMinutes(offset: unknown): number | null {
  if (typeof offset !== 'string') return null;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -totalMinutes : totalMinutes;
}

export async function extractExif(buffer: Buffer): Promise<PhotoExif> {
  const data = await exifr.parse(buffer, { gps: true });

  if (!data) {
    return { camera: null, date: null, latitude: null, lens: null, longitude: null, other: {}, utcOffsetMinutes: null };
  }

  const camera = data.Make && data.Model ? `${data.Make}: ${data.Model}`.trim() : (data.Model ?? null);
  const utcOffsetMinutes = parseUtcOffsetMinutes(data.OffsetTimeOriginal);

  // exifr parses EXIF's naive "YYYY:MM:DD HH:mm:ss" DateTimeOriginal string
  // using this process's local timezone (Date's local-component
  // constructor) — it carries no real timezone info. Reading it back with
  // local getters, in this same process, exactly recovers the camera's
  // original wall-clock numbers regardless of what that local timezone
  // actually is, which is what makes the offset math below correct even
  // though we never learn the *process's* timezone.
  const wallClock = data.DateTimeOriginal as Date | undefined;
  let date: Date | null = wallClock ?? null;
  if (wallClock && utcOffsetMinutes !== null) {
    // The camera recorded its real UTC offset at capture time, so — unlike
    // the naive-local fallback below — this is a genuine absolute instant,
    // not a guess that happens to be right only when this process's own
    // timezone matches the camera's.
    date = new Date(
      Date.UTC(
        wallClock.getFullYear(),
        wallClock.getMonth(),
        wallClock.getDate(),
        wallClock.getHours(),
        wallClock.getMinutes(),
        wallClock.getSeconds()
      ) -
        utcOffsetMinutes * 60_000
    );
  }

  return {
    camera,
    date,
    latitude: typeof data.latitude === 'number' ? data.latitude : null,
    lens: data.LensModel ?? null,
    longitude: typeof data.longitude === 'number' ? data.longitude : null,
    other: buildOther(data),
    utcOffsetMinutes,
  };
}
