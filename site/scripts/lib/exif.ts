import exifr from 'exifr';

export interface PhotoExif {
  camera: string | null;
  date: Date | null;
  latitude: number | null;
  lens: string | null;
  longitude: number | null;
}

export async function extractExif(buffer: Buffer): Promise<PhotoExif> {
  const data = await exifr.parse(buffer, {
    gps: true,
    pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'latitude', 'longitude'],
  });

  if (!data) {
    return { camera: null, date: null, latitude: null, lens: null, longitude: null };
  }

  const camera = data.Make && data.Model ? `${data.Make} ${data.Model}`.trim() : (data.Model ?? null);

  return {
    camera,
    date: data.DateTimeOriginal ?? null,
    latitude: typeof data.latitude === 'number' ? data.latitude : null,
    lens: data.LensModel ?? null,
    longitude: typeof data.longitude === 'number' ? data.longitude : null,
  };
}
