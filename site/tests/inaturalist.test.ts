import { describe, it, expect, vi } from 'vitest';
import {
  attachPhoto,
  createObservation,
  fetchAccessToken,
  fetchJwt,
  getObservationTaxon,
  publishToInaturalist,
  resolveTaxon,
} from '../scripts/lib/inaturalist';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('resolveTaxon', () => {
  it('returns the first match taxon id and preferred common name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] })
    );
    const result = await resolveTaxon({ fetch: fetchMock }, 'Pandion haliaetus');
    expect(result).toEqual({ commonName: 'Osprey', taxonId: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.inaturalist.org/v1/taxa?q=Pandion%20haliaetus'
    );
  });

  it('falls back to an empty common name when iNaturalist has none on file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ id: 5 }] }));
    const result = await resolveTaxon({ fetch: fetchMock }, 'Pandion haliaetus');
    expect(result.commonName).toBe('');
  });

  it('throws when no taxon matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await expect(resolveTaxon({ fetch: fetchMock }, 'Nonexistens fakeus')).rejects.toThrow(
      /No iNaturalist taxon found/
    );
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(resolveTaxon({ fetch: fetchMock }, 'Pandion haliaetus')).rejects.toThrow(
      /taxon lookup failed: 500/
    );
  });
});

describe('fetchAccessToken', () => {
  it('posts password-grant credentials and returns the access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'token-123' }));
    const credentials = { appId: 'id', appSecret: 'secret', password: 'pw', username: 'user' };
    const token = await fetchAccessToken({ fetch: fetchMock }, credentials);
    expect(token).toBe('token-123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.inaturalist.org/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: 'id',
          client_secret: 'secret',
          grant_type: 'password',
          password: 'pw',
          username: 'user',
        }),
      })
    );
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    await expect(
      fetchAccessToken({ fetch: fetchMock }, { appId: '', appSecret: '', password: '', username: '' })
    ).rejects.toThrow(/OAuth token request failed: 401/);
  });
});

describe('fetchJwt', () => {
  it('exchanges an access token for a JWT api_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ api_token: 'jwt-abc' }));
    const jwt = await fetchJwt({ fetch: fetchMock }, 'token-123');
    expect(jwt).toBe('jwt-abc');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.inaturalist.org/v1/users/api_token',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-123' } })
    );
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    await expect(fetchJwt({ fetch: fetchMock }, 'bad-token')).rejects.toThrow(
      /JWT request failed: 401/
    );
  });
});

describe('createObservation', () => {
  it('posts the observation and returns its id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 999 }));
    const observedOn = new Date('2026-06-14T12:00:00Z');
    const id = await createObservation({ fetch: fetchMock }, 'jwt-abc', {
      latitude: 38.9784,
      longitude: -76.4922,
      observedOn,
      taxonId: 5,
    });
    expect(id).toBe(999);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.inaturalist.org/v1/observations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-abc' }),
        body: JSON.stringify({
          observation: {
            latitude: 38.9784,
            longitude: -76.4922,
            observed_on_string: observedOn.toISOString(),
            taxon_id: 5,
          },
        }),
      })
    );
  });

  it('omits observed_on_string when observedOn is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 999 }));
    await createObservation({ fetch: fetchMock }, 'jwt-abc', {
      latitude: null,
      longitude: null,
      observedOn: null,
      taxonId: 5,
    });
    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((init as { body: string }).body);
    expect(sentBody.observation.observed_on_string).toBeUndefined();
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 422));
    await expect(
      createObservation({ fetch: fetchMock }, 'jwt-abc', {
        latitude: null,
        longitude: null,
        observedOn: null,
        taxonId: 5,
      })
    ).rejects.toThrow(/observation creation failed: 422/);
  });
});

describe('attachPhoto', () => {
  it('multipart-uploads the photo bytes to the observation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 200));
    await attachPhoto({ fetch: fetchMock }, 'jwt-abc', 999, Buffer.from('photo-bytes'));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.inaturalist.org/v1/observation_photos',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer jwt-abc' },
      })
    );
    const [, init] = fetchMock.mock.calls[0];
    expect((init as { body: FormData }).body).toBeInstanceOf(FormData);
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      attachPhoto({ fetch: fetchMock }, 'jwt-abc', 999, Buffer.from('x'))
    ).rejects.toThrow(/photo attach failed: 500/);
  });
});

describe('publishToInaturalist', () => {
  it('runs taxon lookup, auth, observation creation, and photo attach in order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] })) // resolveTaxon
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' })) // fetchAccessToken
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' })) // fetchJwt
      .mockResolvedValueOnce(jsonResponse({ id: 999 })) // createObservation
      .mockResolvedValueOnce(jsonResponse({}, true, 200)); // attachPhoto

    const result = await publishToInaturalist(
      { fetch: fetchMock },
      { appId: 'id', appSecret: 'secret', password: 'pw', username: 'user' },
      {
        latitude: 38.9784,
        longitude: -76.4922,
        observedOn: new Date('2026-06-14T12:00:00Z'),
        photo: Buffer.from('photo-bytes'),
        species: 'Pandion haliaetus',
      }
    );

    expect(result).toEqual({ commonName: 'Osprey', observationId: 999 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('propagates a failure from any step without catching it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      publishToInaturalist(
        { fetch: fetchMock },
        { appId: 'id', appSecret: 'secret', password: 'pw', username: 'user' },
        {
          latitude: null,
          longitude: null,
          observedOn: null,
          photo: Buffer.from('x'),
          species: 'Pandion haliaetus',
        }
      )
    ).rejects.toThrow();
  });
});

describe('getObservationTaxon', () => {
  it('returns the community taxon name when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ taxon: { name: 'Pandion haliaetus', preferred_common_name: 'Osprey' } }],
      })
    );
    const result = await getObservationTaxon({ fetch: fetchMock }, 999);
    expect(result).toEqual({ commonName: 'Osprey', scientificName: 'Pandion haliaetus' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.inaturalist.org/v1/observations/999');
  });

  it('throws when the request is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(getObservationTaxon({ fetch: fetchMock }, 999)).rejects.toThrow(
      /observation lookup failed: 500/
    );
  });

  it('falls back to an empty common name when the community taxon has none on file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ taxon: { name: 'Pandion haliaetus' } }] })
    );
    const result = await getObservationTaxon({ fetch: fetchMock }, 999);
    expect(result).toEqual({ commonName: '', scientificName: 'Pandion haliaetus' });
  });

  it('returns null when the observation has no taxon yet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ taxon: null }] }));
    const result = await getObservationTaxon({ fetch: fetchMock }, 999);
    expect(result).toBeNull();
  });

  it('returns null when the observation id no longer exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const result = await getObservationTaxon({ fetch: fetchMock }, 999);
    expect(result).toBeNull();
  });
});
