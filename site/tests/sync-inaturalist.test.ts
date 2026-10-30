import { describe, it, expect, vi } from 'vitest';
import { syncInaturalist } from '../scripts/lib/sync-inaturalist';

const credentials = { appId: 'id', appSecret: 'secret', password: 'pw', username: 'user' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const BACKFILL_YAML = `---
camera: "Sony A7 IV"
datetime: 2026-06-14T12:00:00
file: ospreys/osprey-nest-01
latitude: 38.9784
lens: "100-400mm GM"
longitude: -76.4922
notes: # optional
objects:
  - description: null
    details:
      commonName: ""
      inaturalistObservationId: null
      scientificName: "Pandion haliaetus"
    objectType: organism
other: {}
slug: 2026-06-14-osprey-nest
tier: E
`;

const CURRENT_YAML = `---
camera: "Sony A7 IV"
datetime: 2026-06-14T12:00:00
file: ospreys/osprey-nest-01
latitude: 38.9784
lens: "100-400mm GM"
longitude: -76.4922
notes: # optional
objects:
  - description: null
    details:
      commonName: "Osprey"
      inaturalistObservationId: 999
      scientificName: "Pandion haliaetus"
    objectType: organism
other: {}
slug: 2026-06-14-osprey-nest
tier: E
`;

const BACKFILL_WITH_DESCRIPTION_YAML = `---
camera: "Sony A7 IV"
datetime: 2026-06-14T12:00:00
file: gulls/gull-dock-01
latitude: 38.9784
lens: "100-400mm GM"
longitude: -76.4922
notes: # optional
objects:
  - description: "seen from the north jetty"
    details:
      commonName: ""
      inaturalistObservationId: null
      scientificName: "Larus argentatus"
    objectType: organism
other: {}
slug: 2026-06-14-gull-dock
tier: E
`;

const CURRENT_WITH_DESCRIPTION_YAML = `---
camera: "Sony A7 IV"
datetime: 2026-06-14T12:00:00
file: gulls/gull-dock-01
latitude: 38.9784
lens: "100-400mm GM"
longitude: -76.4922
notes: # optional
objects:
  - description: "seen from the north jetty"
    details:
      commonName: "Herring Gull"
      inaturalistObservationId: 99
      scientificName: "Larus argentatus"
    objectType: organism
other: {}
slug: 2026-06-14-gull-dock
tier: E
`;

const TWO_ORGANISM_BACKFILL_YAML = `---
camera: "Sony A7 IV"
datetime: 2026-06-14T12:00:00
file: ospreys/osprey-nest-01
latitude: 38.9784
lens: "100-400mm GM"
longitude: -76.4922
notes: # optional
objects:
  - description: null
    details:
      commonName: ""
      inaturalistObservationId: null
      scientificName: "Pandion haliaetus"
    objectType: organism
  - description: null
    details:
      commonName: ""
      inaturalistObservationId: null
      scientificName: "Larus argentatus"
    objectType: organism
other: {}
slug: 2026-06-14-osprey-nest
tier: E
`;

const LANDMARK_YAML = `---
camera: null
datetime: 2026-05-20T10:00:00
file: landmarks/lighthouse-01
latitude: null
lens: null
longitude: null
notes: # optional
objects:
  - description: "Cape Charles Lighthouse"
    objectType: landmark
other: {}
slug: 2026-05-20-lighthouse
tier: A
`;

function makeDeps(files: Record<string, string>, fetchMock = vi.fn()) {
  const writeFile = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      fetch: fetchMock,
      glob: vi.fn().mockResolvedValue(Object.keys(files)),
      readFile: vi.fn((path: string) => Promise.resolve(files[path])),
      sleep: vi.fn().mockResolvedValue(undefined),
      writeFile,
    },
    writeFile,
  };
}

describe('syncInaturalist', () => {
  it('backfills a missing observation id by creating a new observation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] })) // resolveTaxon
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' })) // fetchAccessToken
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' })) // fetchJwt
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] })); // createObservation
    // Note: the backfill path has no uploaded photo bytes available (the
    // source image already lives only in R2 by the time sync runs), so it
    // creates the observation without attaching a photo.

    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': BACKFILL_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual(['photos/osprey.yaml']);
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
    expect(writeFile).toHaveBeenCalledWith('photos/osprey.yaml', expect.stringContaining('commonName: "Osprey"'));
  });

  it('refreshes scientificName/commonName when the community taxon disagrees, silently', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ results: [{ taxon: { name: 'Pandion haliaetus carolinensis', preferred_common_name: 'Carolina Osprey' } }] })
    );
    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': CURRENT_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual(['photos/osprey.yaml']);
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('scientificName: "Pandion haliaetus carolinensis"')
    );
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('commonName: "Carolina Osprey"')
    );
  });

  it('makes no changes when the community taxon already matches', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ results: [{ taxon: { name: 'Pandion haliaetus', preferred_common_name: 'Osprey' } }] })
    );
    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': CURRENT_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('skips files with no organism objects', async () => {
    const fetchMock = vi.fn();
    const { deps, writeFile } = makeDeps({ 'photos/lighthouse.yaml': LANDMARK_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('sleeps between files to stay under the rate limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ taxon: { name: 'Pandion haliaetus', preferred_common_name: 'Osprey' } }] })
    );
    const { deps } = makeDeps(
      { 'photos/a.yaml': CURRENT_YAML, 'photos/b.yaml': CURRENT_YAML },
      fetchMock
    );

    await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(deps.sleep).toHaveBeenCalled();
  });

  it('backfills an observation id without touching a non-null description', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Herring Gull' }] })) // resolveTaxon
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' })) // fetchAccessToken
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' })) // fetchJwt
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 4242, uuid: 'obs-uuid' }] })); // createObservation

    const { deps, writeFile } = makeDeps({ 'photos/gull.yaml': BACKFILL_WITH_DESCRIPTION_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual(['photos/gull.yaml']);
    // description now lives outside the block ORGANISM_BLOCK matches, so it
    // is never read or rewritten -- it simply survives untouched in the text.
    expect(writeFile).toHaveBeenCalledWith(
      'photos/gull.yaml',
      expect.stringContaining('description: "seen from the north jetty"')
    );
    expect(writeFile).toHaveBeenCalledWith(
      'photos/gull.yaml',
      expect.stringContaining('inaturalistObservationId: 4242')
    );
    expect(writeFile).toHaveBeenCalledWith('photos/gull.yaml', expect.stringContaining('commonName: "Herring Gull"'));
  });

  it('refreshes a taxon without touching a non-null description', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [{ taxon: { name: 'Larus smithsonianus', preferred_common_name: 'American Herring Gull' } }],
      })
    );
    const { deps, writeFile } = makeDeps({ 'photos/gull.yaml': CURRENT_WITH_DESCRIPTION_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual(['photos/gull.yaml']);
    expect(writeFile).toHaveBeenCalledWith(
      'photos/gull.yaml',
      expect.stringContaining('description: "seen from the north jetty"')
    );
    expect(writeFile).toHaveBeenCalledWith(
      'photos/gull.yaml',
      expect.stringContaining('scientificName: "Larus smithsonianus"')
    );
    expect(writeFile).toHaveBeenCalledWith(
      'photos/gull.yaml',
      expect.stringContaining('commonName: "American Herring Gull"')
    );
  });

  it('persists each organism to disk immediately, so a later failure in the same file does not orphan an already-created observation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] })) // resolveTaxon (osprey)
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' })) // fetchAccessToken (osprey)
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' })) // fetchJwt (osprey)
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] })) // createObservation (osprey) succeeds
      .mockResolvedValueOnce(jsonResponse({}, false, 500)); // resolveTaxon (gull) fails

    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': TWO_ORGANISM_BACKFILL_YAML }, fetchMock);

    await expect(syncInaturalist(deps, credentials, 'photos/*.yaml')).rejects.toThrow();

    // Even though the whole file's organisms were not all processed, the osprey's
    // newly-created observation id must already be on disk -- otherwise the next
    // run would create a second, orphaned observation for the same organism.
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
  });

  it('leaves a null description as the bare literal null, untouched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] })) // resolveTaxon
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' })) // fetchAccessToken
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' })) // fetchJwt
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 999, uuid: 'obs-uuid' }] })); // createObservation

    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': BACKFILL_YAML }, fetchMock);

    await syncInaturalist(deps, credentials, 'photos/*.yaml');

    // description sits outside the block ORGANISM_BLOCK rewrites, so it is
    // carried through as plain surrounding text, never touched at all.
    const written = writeFile.mock.calls[0][1] as string;
    expect(written).toContain('description: null');
    expect(written).not.toContain('description: "null"');
  });
});
