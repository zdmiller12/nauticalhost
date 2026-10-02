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
  - details:
      common_name: ""
      description: null
      inaturalistObservationId: null
      scientific_name: "Pandion haliaetus"
    object_type: organism
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
  - details:
      common_name: "Osprey"
      description: null
      inaturalistObservationId: 999
      scientific_name: "Pandion haliaetus"
    object_type: organism
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
  - details:
      description: "Cape Charles Lighthouse"
    object_type: landmark
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
      .mockResolvedValueOnce(jsonResponse({ id: 999 })); // createObservation
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
    expect(writeFile).toHaveBeenCalledWith('photos/osprey.yaml', expect.stringContaining('common_name: "Osprey"'));
  });

  it('refreshes scientific_name/common_name when the community taxon disagrees, silently', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ results: [{ taxon: { name: 'Pandion haliaetus carolinensis', preferred_common_name: 'Carolina Osprey' } }] })
    );
    const { deps, writeFile } = makeDeps({ 'photos/osprey.yaml': CURRENT_YAML }, fetchMock);

    const result = await syncInaturalist(deps, credentials, 'photos/*.yaml');

    expect(result.changedFiles).toEqual(['photos/osprey.yaml']);
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('scientific_name: "Pandion haliaetus carolinensis"')
    );
    expect(writeFile).toHaveBeenCalledWith(
      'photos/osprey.yaml',
      expect.stringContaining('common_name: "Carolina Osprey"')
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
});
