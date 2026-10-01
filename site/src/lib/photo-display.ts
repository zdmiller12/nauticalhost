import type { PhotoObject } from '../content/schema';

export function objectName(obj: PhotoObject): string {
  return obj.object_type === 'organism' ? obj.details.common_name : obj.details.description;
}

export function photoTitle(objects: PhotoObject[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(objects.map(objectName));
}

// EXIF splits the camera into Make and Model, and most manufacturers repeat
// the make inside the model ("Canon" + "Canon EOS R7"). Accepts both the
// "Make: Model" form publish-photo writes and older space-joined values.
export function formatCamera(camera: string | null | undefined): string | null {
  const trimmed = camera?.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  const [make, model] =
    colon === -1
      ? [trimmed.split(' ')[0], trimmed.slice(trimmed.indexOf(' ') + 1)]
      : [trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()];
  const firstWord = make.split(' ')[0].toLowerCase();
  return model.toLowerCase().startsWith(`${firstWord} `) || model === make ? model : `${make} ${model}`;
}

export function formatCaptureDate(datetime: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(datetime);
}

export function formatCaptureTime(datetime: Date): string {
  return `${datetime.toISOString().slice(11, 16)} UTC`;
}

// Two decimal places is roughly 1 km: enough to place a photo on a map
// without publishing exactly where it was taken (often someone's yard).
const COORDINATE_DECIMALS = 2;

export interface DisplayLocation {
  label: string;
  mapUrl: string;
}

export function formatLocation(latitude: number | null, longitude: number | null): DisplayLocation | null {
  if (latitude === null || longitude === null) return null;
  const lat = latitude.toFixed(COORDINATE_DECIMALS);
  const lon = longitude.toFixed(COORDINATE_DECIMALS);
  const label = `${Math.abs(latitude).toFixed(COORDINATE_DECIMALS)}° ${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(COORDINATE_DECIMALS)}° ${longitude < 0 ? 'W' : 'E'}`;
  return { label, mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}` };
}
