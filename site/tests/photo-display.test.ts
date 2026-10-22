import { describe, it, expect } from 'vitest';
import type { PhotoObject } from '../src/content/schema';
import {
  formatCamera,
  formatCaptureDate,
  formatCaptureTime,
  formatLocation,
  objectName,
  photoTitle,
} from '../src/lib/photo-display';

const osprey: PhotoObject = {
  details: { commonName: 'Osprey', description: null, scientificName: 'Pandion haliaetus' },
  objectType: 'organism',
};
const heron: PhotoObject = {
  details: { commonName: 'Great Blue Heron', description: null, scientificName: 'Ardea herodias' },
  objectType: 'organism',
};
const platform: PhotoObject = { details: { description: 'Nesting platform' }, objectType: 'landmark' };

describe('objectName / photoTitle', () => {
  it('names organisms by common name and landmarks by description', () => {
    expect(objectName(osprey)).toBe('Osprey');
    expect(objectName(platform)).toBe('Nesting platform');
  });

  it('joins several subjects into one readable title', () => {
    expect(photoTitle([osprey])).toBe('Osprey');
    expect(photoTitle([osprey, platform])).toBe('Osprey and Nesting platform');
    expect(photoTitle([osprey, heron, platform])).toBe('Osprey, Great Blue Heron, and Nesting platform');
  });
});

describe('formatCamera', () => {
  it('drops a make that the model already repeats', () => {
    expect(formatCamera('Canon: Canon EOS R7')).toBe('Canon EOS R7');
    expect(formatCamera('Canon Canon EOS R7')).toBe('Canon EOS R7');
    expect(formatCamera('NIKON CORPORATION: NIKON Z 6')).toBe('NIKON Z 6');
  });

  it('keeps a make the model does not repeat', () => {
    expect(formatCamera('Apple: iPhone 15 Pro')).toBe('Apple iPhone 15 Pro');
    expect(formatCamera('SONY: ILCE-7M3')).toBe('SONY ILCE-7M3');
    expect(formatCamera('iPhone 12')).toBe('iPhone 12');
  });

  it('passes through a lone model name', () => {
    expect(formatCamera('X100V')).toBe('X100V');
  });

  it('returns null for missing or blank values', () => {
    expect(formatCamera(null)).toBeNull();
    expect(formatCamera(undefined)).toBeNull();
    expect(formatCamera('  ')).toBeNull();
  });
});

describe('formatCaptureDate / formatCaptureTime', () => {
  const datetime = new Date('2025-09-13T23:05:44Z');

  it('formats in UTC, matching the timestamp as stored', () => {
    expect(formatCaptureDate(datetime)).toBe('September 13, 2025');
    expect(formatCaptureTime(datetime)).toBe('23:05 UTC');
  });
});

describe('formatLocation', () => {
  it('rounds to about a kilometer and labels hemispheres', () => {
    expect(formatLocation(37.162349, -80.447362)).toEqual({
      label: '37.16° N, 80.45° W',
      mapUrl: 'https://www.openstreetmap.org/?mlat=37.16&mlon=-80.45#map=13/37.16/-80.45',
    });
    expect(formatLocation(-33.8568, 151.2153)?.label).toBe('33.86° S, 151.22° E');
  });

  it('returns null when either coordinate is missing', () => {
    expect(formatLocation(null, -80.4)).toBeNull();
    expect(formatLocation(37.1, null)).toBeNull();
  });
});
