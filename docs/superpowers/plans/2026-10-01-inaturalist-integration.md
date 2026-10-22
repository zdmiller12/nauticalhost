# iNaturalist Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `publish-photo` optionally create an iNaturalist observation for a photographed organism and store the resulting `inaturalistObservationId` on the photo's `organism` object, then (last) add a daily sync job that backfills missing IDs and refreshes species data from the iNaturalist community.

**Architecture:** A new `lib/inaturalist.ts` module wraps the iNaturalist REST API (taxon lookup, OAuth2 password-grant → JWT exchange, observation creation, photo attachment) behind a small `fetch`-injecting dependency interface, matching this repo's existing `PublishDeps`/`CliIo` DI pattern. `publish.ts` and `cli.ts` are extended (not rewritten) to thread an optional `--species` flag through to that module. The sync job (`lib/sync-inaturalist.ts`, built last) reuses the same module's taxon/auth primitives and edits existing YAML files via targeted string replacement, following the precedent set by `backfill-exif-other.ts`.

**Tech Stack:** TypeScript, Node 22 (native `fetch`/`FormData`/`Blob`, no new HTTP dependency needed), Vitest, Zod, js-yaml (read-only, for the sync job's diffing), tsx.

**Spec:** `docs/superpowers/specs/2026-10-01-inaturalist-integration-design.md`

## Global Constraints

- iNaturalist REST API base: `https://api.inaturalist.org/v1`. OAuth token endpoint: `https://www.inaturalist.org/oauth/token`.
- Rate limit: stay under ~1 request/second, 10,000/day (only the sync job makes repeated calls — add a sleep between files).
- YAML files are edited via string manipulation, never full parse-and-reserialize with `js-yaml` — preserves hand-written comments/formatting (existing precedent: `site/scripts/lib/backfill-exif-other.ts`).
- No `config.ts` abstraction — env vars are read directly off `io.env` in `cli.ts` with explicit missing-var checks, following the existing `R2_*` pattern.
- Alphabetical field ordering within object literals/schemas (existing repo convention).
- Any iNaturalist call failing during `publish-photo` must warn and continue — a photo is never blocked from publishing.
- **Deviation from the spec, discovered during implementation:** the spec's flow step 4 says "attaching the already-uploaded lightbox image (R2 URL)" via `POST /observation_photos`. iNaturalist's real API does not accept a remote URL there — `observation_photos` requires the image bytes themselves as a multipart `file` upload. Tasks below have `publishToInaturalist` take the in-memory `lightbox` `Buffer` (already available in `publishPhoto` before it's uploaded to R2) and multipart-upload it directly, instead of passing a URL. This changes only the HTTP mechanics, not the design's shape, data model, or user-facing behavior — flagging it here rather than reopening the spec review gate.
- **Later migration (post-implementation):** `lib/inaturalist.ts` was subsequently migrated from the v1 to the v2 REST API (`https://api.inaturalist.org/v2`). The code snippets and URLs below reflect the v1 implementation as originally planned/built; see the spec (now updated) and the current source for v2's shape — notably its mandatory `fields` sparse-fieldset param, response bodies wrapped in `{ results: [...] }`, and `observation_photos` keying off the observation's `uuid` rather than its integer `id`. This plan file is left as a historical record and not updated in place.

---

### Task 1: Schema change — `inaturalistObservationId`

**Files:**
- Modify: `site/src/content/schema.ts`
- Test: `site/tests/content-schema.test.ts`

**Interfaces:**
- Produces: the `organism` variant of `photoObjectSchema` gains `details.inaturalistObservationId: number | null` (default `null`). Later tasks (`buildMetadataYaml`) write this field name exactly.

- [ ] **Step 1: Write the failing tests**

Add to `site/tests/content-schema.test.ts`, inside the existing `describe('photoSchema', ...)` block (after the "accepts a valid photo with an organism object" test):

```ts
  it('accepts an organism object with an inaturalistObservationId', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          details: {
            common_name: 'Osprey',
            description: null,
            inaturalistObservationId: 123456,
            scientific_name: 'Pandion haliaetus',
          },
          object_type: 'organism',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults inaturalistObservationId to null when omitted', () => {
    const result = photoSchema.parse({
      ...basePhoto,
      objects: [
        {
          details: { common_name: 'Osprey', description: null, scientific_name: 'Pandion haliaetus' },
          object_type: 'organism',
        },
      ],
    });
    const organism = result.objects[0] as { details: { inaturalistObservationId: number | null } };
    expect(organism.details.inaturalistObservationId).toBeNull();
  });

  it('rejects a non-numeric inaturalistObservationId', () => {
    const result = photoSchema.safeParse({
      ...basePhoto,
      objects: [
        {
          details: {
            common_name: 'Osprey',
            description: null,
            inaturalistObservationId: 'not-a-number',
            scientific_name: 'Pandion haliaetus',
          },
          object_type: 'organism',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run tests/content-schema.test.ts`
Expected: the "accepts an organism object with an inaturalistObservationId" test FAILs with a Zod "unrecognized key" or the default-null test fails because the property is `undefined`, not `null`.

- [ ] **Step 3: Add the field to the schema**

In `site/src/content/schema.ts`, change the `organism` variant:

```ts
  z.object({
    details: z.object({
      common_name: z.string(),
      description: z.string().nullable(),
      inaturalistObservationId: z.number().nullable().default(null),
      scientific_name: z.string(),
    }),
    object_type: z.literal('organism'),
  }),
```

(Only the `details` object inside the existing `photoObjectSchema` discriminated union changes — insert `inaturalistObservationId` alphabetically between `description` and `scientific_name`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run tests/content-schema.test.ts`
Expected: PASS, including the pre-existing tests in this file (no regressions).

- [ ] **Step 5: Commit**

```bash
git add site/src/content/schema.ts site/tests/content-schema.test.ts
git commit -m "Add inaturalistObservationId to organism photo schema"
```

---

### Task 2: `lib/inaturalist.ts` — API client module

**Files:**
- Create: `site/scripts/lib/inaturalist.ts`
- Test: `site/tests/inaturalist.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (consumed by Task 3 and Task 5):
  - `export interface InaturalistDeps { fetch: typeof fetch }`
  - `export interface InaturalistCredentials { appId: string; appSecret: string; password: string; username: string }`
  - `export interface ObservationInput { latitude: number | null; longitude: number | null; observedOn: Date | null; photo: Buffer; species: string }`
  - `export interface ObservationResult { commonName: string; observationId: number }`
  - `export async function resolveTaxon(deps: InaturalistDeps, species: string): Promise<{ commonName: string; taxonId: number }>`
  - `export async function fetchAccessToken(deps: InaturalistDeps, credentials: InaturalistCredentials): Promise<string>`
  - `export async function fetchJwt(deps: InaturalistDeps, accessToken: string): Promise<string>`
  - `export async function createObservation(deps: InaturalistDeps, jwt: string, args: { latitude: number | null; longitude: number | null; observedOn: Date | null; taxonId: number }): Promise<number>`
  - `export async function attachPhoto(deps: InaturalistDeps, jwt: string, observationId: number, photo: Buffer): Promise<void>`
  - `export async function publishToInaturalist(deps: InaturalistDeps, credentials: InaturalistCredentials, input: ObservationInput): Promise<ObservationResult>` — orchestrates the four calls above, in order; throws on the first failure (no retry/catch inside — callers decide how to handle failure).
  - `export async function getObservationTaxon(deps: InaturalistDeps, observationId: number): Promise<{ commonName: string; scientificName: string } | null>` — unauthenticated read, used only by Task 5's sync job; returns `null` if the observation has no community taxon yet.

- [ ] **Step 1: Write the failing tests**

Create `site/tests/inaturalist.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run tests/inaturalist.test.ts`
Expected: FAIL — `../scripts/lib/inaturalist` does not exist yet (module not found).

- [ ] **Step 3: Implement `site/scripts/lib/inaturalist.ts`**

```ts
export interface InaturalistDeps {
  fetch: typeof fetch;
}

export interface InaturalistCredentials {
  appId: string;
  appSecret: string;
  password: string;
  username: string;
}

export interface ObservationInput {
  latitude: number | null;
  longitude: number | null;
  observedOn: Date | null;
  photo: Buffer;
  species: string;
}

export interface ObservationResult {
  commonName: string;
  observationId: number;
}

const API_BASE = 'https://api.inaturalist.org/v1';

export async function resolveTaxon(
  deps: InaturalistDeps,
  species: string
): Promise<{ commonName: string; taxonId: number }> {
  const res = await deps.fetch(`${API_BASE}/taxa?q=${encodeURIComponent(species)}`);
  if (!res.ok) throw new Error(`iNaturalist taxon lookup failed: ${res.status}`);
  const body = (await res.json()) as { results: Array<{ id: number; preferred_common_name?: string }> };
  const match = body.results[0];
  if (!match) throw new Error(`No iNaturalist taxon found for "${species}"`);
  return { commonName: match.preferred_common_name ?? '', taxonId: match.id };
}

export async function fetchAccessToken(
  deps: InaturalistDeps,
  credentials: InaturalistCredentials
): Promise<string> {
  const res = await deps.fetch('https://www.inaturalist.org/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
      grant_type: 'password',
      password: credentials.password,
      username: credentials.username,
    }),
  });
  if (!res.ok) throw new Error(`iNaturalist OAuth token request failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export async function fetchJwt(deps: InaturalistDeps, accessToken: string): Promise<string> {
  const res = await deps.fetch(`${API_BASE}/users/api_token`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`iNaturalist JWT request failed: ${res.status}`);
  const body = (await res.json()) as { api_token: string };
  return body.api_token;
}

export async function createObservation(
  deps: InaturalistDeps,
  jwt: string,
  args: { latitude: number | null; longitude: number | null; observedOn: Date | null; taxonId: number }
): Promise<number> {
  const res = await deps.fetch(`${API_BASE}/observations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      observation: {
        latitude: args.latitude,
        longitude: args.longitude,
        observed_on_string: args.observedOn ? args.observedOn.toISOString() : undefined,
        taxon_id: args.taxonId,
      },
    }),
  });
  if (!res.ok) throw new Error(`iNaturalist observation creation failed: ${res.status}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

export async function attachPhoto(
  deps: InaturalistDeps,
  jwt: string,
  observationId: number,
  photo: Buffer
): Promise<void> {
  const form = new FormData();
  form.append('observation_photo[observation_id]', String(observationId));
  form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');

  const res = await deps.fetch(`${API_BASE}/observation_photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`iNaturalist photo attach failed: ${res.status}`);
}

export async function publishToInaturalist(
  deps: InaturalistDeps,
  credentials: InaturalistCredentials,
  input: ObservationInput
): Promise<ObservationResult> {
  const { commonName, taxonId } = await resolveTaxon(deps, input.species);
  const accessToken = await fetchAccessToken(deps, credentials);
  const jwt = await fetchJwt(deps, accessToken);
  const observationId = await createObservation(deps, jwt, {
    latitude: input.latitude,
    longitude: input.longitude,
    observedOn: input.observedOn,
    taxonId,
  });
  await attachPhoto(deps, jwt, observationId, input.photo);
  return { commonName, observationId };
}

export async function getObservationTaxon(
  deps: InaturalistDeps,
  observationId: number
): Promise<{ commonName: string; scientificName: string } | null> {
  const res = await deps.fetch(`${API_BASE}/observations/${observationId}`);
  if (!res.ok) throw new Error(`iNaturalist observation lookup failed: ${res.status}`);
  const body = (await res.json()) as {
    results: Array<{ taxon: { name: string; preferred_common_name?: string } | null }>;
  };
  const taxon = body.results[0]?.taxon;
  if (!taxon) return null;
  return { commonName: taxon.preferred_common_name ?? '', scientificName: taxon.name };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run tests/inaturalist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add site/scripts/lib/inaturalist.ts site/tests/inaturalist.test.ts
git commit -m "Add lib/inaturalist.ts iNaturalist API client"
```

---

### Task 3: Wire `--species` into `publishPhoto`

**Files:**
- Modify: `site/scripts/lib/publish.ts`
- Test: `site/tests/publish.test.ts`

**Interfaces:**
- Consumes: `publishToInaturalist`'s shape from Task 2 (`{ latitude, longitude, observedOn, photo, species } => Promise<{ commonName, observationId }>` — bound to credentials by the caller, so `PublishDeps.publishToInaturalist` only takes the per-call fields).
- Produces (consumed by Task 4): `PublishArgs` gains optional `species?: string`. `PublishDeps` gains optional `publishToInaturalist?: (args: { latitude: number | null; longitude: number | null; observedOn: Date | null; photo: Buffer; species: string }) => Promise<{ commonName: string; observationId: number }>` and required `warn: (msg: string) => void`.

- [ ] **Step 1: Write the failing tests**

Add to `site/tests/publish.test.ts` (new `describe` block, after the existing `describe('publishPhoto', ...)`):

```ts
describe('publishPhoto with --species', () => {
  const exif: PhotoExif = {
    camera: 'Sony A7 IV',
    date: new Date(2026, 5, 14, 12, 0, 0),
    latitude: 38.9784,
    lens: '100-400mm GM',
    longitude: -76.4922,
    other: {},
    utcOffsetMinutes: null,
  };

  function makeDeps(overrides: Partial<Parameters<typeof publishPhoto>[0]> = {}) {
    return {
      extractExif: vi.fn().mockResolvedValue(exif),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from('source-bytes')),
      resizePhoto: vi.fn().mockResolvedValue({ thumb: Buffer.from('t'), lightbox: Buffer.from('l') }),
      uploadObject: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('writes a real organism entry when the iNaturalist call succeeds', async () => {
    const publishToInaturalist = vi.fn().mockResolvedValue({ commonName: 'Osprey', observationId: 999 });
    const deps = makeDeps({ publishToInaturalist });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
      species: 'Pandion haliaetus',
    });

    expect(publishToInaturalist).toHaveBeenCalledWith({
      latitude: 38.9784,
      longitude: -76.4922,
      observedOn: exif.date,
      photo: Buffer.from('l'),
      species: 'Pandion haliaetus',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('common_name: "Osprey"');
    expect(yaml).toContain('scientific_name: "Pandion haliaetus"');
    expect(yaml).toContain('inaturalistObservationId: 999');
    expect(yaml).toContain('object_type: organism');
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('still writes valid YAML with a null id when the iNaturalist call fails', async () => {
    const publishToInaturalist = vi.fn().mockRejectedValue(new Error('network down'));
    const deps = makeDeps({ publishToInaturalist });

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
      species: 'Pandion haliaetus',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('scientific_name: "Pandion haliaetus"');
    expect(yaml).toContain('inaturalistObservationId: null');
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
  });

  it('leaves the commented placeholder when species is omitted', async () => {
    const deps = makeDeps();

    await publishPhoto(deps, {
      bucket: 'photos',
      contentDir: 'src/content/photos',
      r2KeyPrefix: 'ospreys/osprey-nest-01',
      slug: '2026-06-14-osprey-nest',
      sourcePath: '/tmp/source.jpg',
    });

    const [, yaml] = deps.writeFile.mock.calls[0];
    expect(yaml).toContain('#   object_type: organism');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run tests/publish.test.ts`
Expected: FAIL — `species` and `publishToInaturalist` aren't recognized/used yet, so the organism assertions fail against the still-commented placeholder.

- [ ] **Step 3: Implement the changes in `site/scripts/lib/publish.ts`**

Replace the full file contents with:

```ts
import type { PhotoExif } from './exif';

export interface PublishDeps {
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  mkdir: (path: string) => Promise<unknown>;
  publishToInaturalist?: (args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    photo: Buffer;
    species: string;
  }) => Promise<{ commonName: string; observationId: number }>;
  readFile: (path: string) => Promise<Buffer>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  warn: (msg: string) => void;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface PublishArgs {
  bucket: string;
  contentDir: string;
  r2KeyPrefix: string;
  slug: string;
  sourcePath: string;
  species?: string;
}

export interface OrganismEntry {
  commonName: string;
  inaturalistObservationId: number | null;
  scientificName: string;
}

function formatDatetime(date: Date, utcOffsetMinutes: number | null): string {
  if (typeof utcOffsetMinutes === 'number') {
    // `date` is a genuine absolute instant (see extractExif) — format its
    // actual UTC clock reading directly (no offset reapplication) and mark
    // it with a trailing Z, since we can honestly claim this is UTC.
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
  }
  // No known offset: `date` is only exifr's naive-local guess (this
  // process's timezone applied to the camera's raw, timezone-less
  // wall-clock string). Local getters recover that original wall-clock
  // reading, but since it's not a verified UTC instant, omit the Z rather
  // than falsely claim one.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/** Renders an `other` catch-all map as a YAML block, alphabetized by key. */
export function formatOtherYaml(other: Record<string, string | number | boolean> | undefined): string {
  const entries = Object.entries(other ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'other: {}';
  const lines = entries.map(([key, value]) => `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
  return `other:\n${lines.join('\n')}`;
}

/** Renders the `objects:` block — a real organism entry when one was resolved, a commented placeholder otherwise. */
function formatObjectsYaml(organism: OrganismEntry | null): string {
  if (!organism) {
    return `objects:
  # - details:
  #     common_name: ""
  #     description: null
  #     scientific_name: ""
  #   object_type: organism`;
  }
  return `objects:
  - details:
      common_name: ${JSON.stringify(organism.commonName)}
      description: null
      inaturalistObservationId: ${organism.inaturalistObservationId ?? 'null'}
      scientific_name: ${JSON.stringify(organism.scientificName)}
    object_type: organism`;
}

export function buildMetadataYaml(
  slug: string,
  file: string,
  exif: PhotoExif,
  organism: OrganismEntry | null = null
): string {
  const datetimeStr = exif.date ? formatDatetime(exif.date, exif.utcOffsetMinutes) : '';
  return `---
camera: ${JSON.stringify(exif.camera ?? '')}
datetime: ${datetimeStr}
file: ${file}
latitude: ${exif.latitude ?? 'null'}
lens: ${JSON.stringify(exif.lens ?? '')}
longitude: ${exif.longitude ?? 'null'}
notes: # optional
${formatObjectsYaml(organism)}
${formatOtherYaml(exif.other)}
slug: ${slug}
tier: E
`;
}

export async function publishPhoto(deps: PublishDeps, args: PublishArgs): Promise<void> {
  const source = await deps.readFile(args.sourcePath);
  const exif = await deps.extractExif(source);
  const { thumb, lightbox } = await deps.resizePhoto(source);

  const thumbKey = `${args.r2KeyPrefix}-thumb.jpg`;
  const lightboxKey = `${args.r2KeyPrefix}-lg.jpg`;

  await deps.uploadObject(args.bucket, thumbKey, thumb, 'image/jpeg');
  await deps.uploadObject(args.bucket, lightboxKey, lightbox, 'image/jpeg');

  let organism: OrganismEntry | null = null;
  if (args.species && deps.publishToInaturalist) {
    try {
      const result = await deps.publishToInaturalist({
        latitude: exif.latitude,
        longitude: exif.longitude,
        observedOn: exif.date,
        photo: lightbox,
        species: args.species,
      });
      organism = {
        commonName: result.commonName,
        inaturalistObservationId: result.observationId,
        scientificName: args.species,
      };
    } catch (err) {
      deps.warn(`iNaturalist publish failed for "${args.species}": ${(err as Error).message}`);
      organism = { commonName: '', inaturalistObservationId: null, scientificName: args.species };
    }
  }

  const yaml = buildMetadataYaml(args.slug, args.r2KeyPrefix, exif, organism);
  await deps.mkdir(args.contentDir);
  await deps.writeFile(`${args.contentDir}/${args.slug}.yaml`, yaml);
}
```

Note: `formatObjectsYaml`'s real-organism branch and the existing round-trip tests both rely on `JSON.stringify` for string fields — this matches the existing `camera`/`lens` rendering convention already in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run tests/publish.test.ts`
Expected: PASS, including every pre-existing test in the file (the default `organism = null` parameter keeps the no-species path byte-identical to before).

- [ ] **Step 5: Commit**

```bash
git add site/scripts/lib/publish.ts site/tests/publish.test.ts
git commit -m "Thread optional species/iNaturalist result into publishPhoto"
```

---

### Task 4: `--species` CLI flag and iNaturalist credentials

**Files:**
- Modify: `site/scripts/lib/cli.ts`
- Modify: `site/.env.example`
- Test: `site/tests/cli.test.ts`

**Interfaces:**
- Consumes: `PublishDeps`/`PublishArgs` from Task 3; `InaturalistDeps`, `InaturalistCredentials`, `publishToInaturalist` from Task 2.
- Produces: `CliIo` gains `fetch: typeof fetch`. `runCli` accepts a third+ argv pair (`--species "<name>"`), wires `INATURALIST_*` env vars only when that flag is present, and passes `species`/`publishToInaturalist`/`warn` through to `publishPhoto`.

- [ ] **Step 1: Write the failing tests**

Add to `site/tests/cli.test.ts`. First, extend the shared `makeIo` helper with a `fetch` default (add this line inside the returned object, alongside the other `vi.fn()` defaults):

```ts
    fetch: vi.fn(),
```

Then add a new `describe` block at the end of the file:

```ts
describe('runCli with --species', () => {
  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
  }

  it('prints a missing-env-vars error and exits 1 when --species is given without iNaturalist config', async () => {
    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/2026-06-14-osprey-nest.jpg',
        'ospreys/osprey-nest-01',
        '--species',
        'Pandion haliaetus',
      ],
      env: {
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
    });

    await runCli(io);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing iNaturalist env vars'));
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('resolves the taxon and publishes an observation when --species and iNaturalist config are both present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 5, preferred_common_name: 'Osprey' }] }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-123' }))
      .mockResolvedValueOnce(jsonResponse({ api_token: 'jwt-abc' }))
      .mockResolvedValueOnce(jsonResponse({ id: 999 }))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));

    const io = makeIo({
      argv: [
        'node',
        'publish-photo.ts',
        '/tmp/2026-06-14-osprey-nest.jpg',
        'ospreys/osprey-nest-01',
        '--species',
        'Pandion haliaetus',
      ],
      env: {
        INATURALIST_APP_ID: 'app-id',
        INATURALIST_APP_SECRET: 'app-secret',
        INATURALIST_PASSWORD: 'pw',
        INATURALIST_USERNAME: 'user',
        R2_ACCESS_KEY_ID: 'key',
        R2_ACCOUNT_ID: 'acct',
        R2_BUCKET_NAME: 'photos',
        R2_SECRET_ACCESS_KEY: 'secret',
      },
      fetch: fetchMock,
    });

    await runCli(io);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(io.writeFile).toHaveBeenCalledWith(
      'src/content/photos/2026-06-14-osprey-nest.yaml',
      expect.stringContaining('inaturalistObservationId: 999')
    );
    expect(io.exit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run tests/cli.test.ts`
Expected: FAIL — `--species` is currently ignored (treated as part of an unused argv tail), so no missing-env-var check fires and `fetchMock` is never called.

- [ ] **Step 3: Implement the changes in `site/scripts/lib/cli.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { extractExif, type PhotoExif } from './exif';
import { resizePhoto } from './resize';
import { createR2Client, uploadObject } from './r2';
import { publishPhoto } from './publish';
import { publishToInaturalist as corePublishToInaturalist } from './inaturalist';

export interface CliIo {
  argv: string[];
  createR2Client: typeof createR2Client;
  env: NodeJS.ProcessEnv;
  error: (msg: string) => void;
  exit: (code: number) => void;
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  fetch: typeof fetch;
  log: (msg: string) => void;
  mkdir: (path: string) => Promise<unknown>;
  readFile: (path: string) => Promise<Buffer>;
  resizePhoto: (buffer: Buffer) => Promise<{ thumb: Buffer; lightbox: Buffer }>;
  uploadObject: (
    client: Pick<S3Client, 'send'>,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string
  ) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

/** Wires CliIo to the real Node/AWS/exifr/sharp implementations. */
export function createRealCliIo(): CliIo {
  return {
    argv: process.argv,
    createR2Client,
    env: process.env,
    error: (msg) => console.error(msg),
    /* v8 ignore next -- calling the real process.exit would kill the test runner */
    exit: (code) => process.exit(code),
    extractExif,
    fetch,
    log: (msg) => console.log(msg),
    mkdir: (path) => mkdir(path, { recursive: true }),
    readFile,
    resizePhoto,
    uploadObject,
    writeFile,
  };
}

/** Pulls `--species "<name>"` out of the trailing CLI args, if present. */
function parseSpeciesFlag(flagArgs: string[]): string | undefined {
  const index = flagArgs.indexOf('--species');
  if (index === -1) return undefined;
  return flagArgs[index + 1];
}

export async function runCli(io: CliIo): Promise<void> {
  const [sourcePath, r2KeyPrefixArg, ...flagArgs] = io.argv.slice(2);
  if (!sourcePath || !r2KeyPrefixArg) {
    io.error('Usage: npm run publish-photo -- <sourcePath> <r2KeyPrefix> [--species "<scientific name>"]');
    io.exit(1);
    return;
  }

  const species = parseSpeciesFlag(flagArgs);

  const fileName = basename(sourcePath);
  const slug = fileName.slice(0, fileName.length - extname(fileName).length);
  const r2KeyPrefix = `${r2KeyPrefixArg.replace(/\/+$/, '')}/${fileName}`;

  const accessKeyId = io.env.R2_ACCESS_KEY_ID;
  const accountId = io.env.R2_ACCOUNT_ID;
  const bucket = io.env.R2_BUCKET_NAME;
  const secretAccessKey = io.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !accountId || !bucket || !secretAccessKey) {
    io.error('Missing R2 env vars. Copy site/.env.example to site/.env and fill it in.');
    io.exit(1);
    return;
  }

  let publishToInaturalist: ((args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    photo: Buffer;
    species: string;
  }) => Promise<{ commonName: string; observationId: number }>) | undefined;

  if (species) {
    const appId = io.env.INATURALIST_APP_ID;
    const appSecret = io.env.INATURALIST_APP_SECRET;
    const password = io.env.INATURALIST_PASSWORD;
    const username = io.env.INATURALIST_USERNAME;

    if (!appId || !appSecret || !password || !username) {
      io.error('Missing iNaturalist env vars. Copy site/.env.example to site/.env and fill it in.');
      io.exit(1);
      return;
    }

    const credentials = { appId, appSecret, password, username };
    publishToInaturalist = (args) => corePublishToInaturalist({ fetch: io.fetch }, credentials, args);
  }

  const client = io.createR2Client({ accessKeyId, accountId, bucket, secretAccessKey });

  await publishPhoto(
    {
      extractExif: io.extractExif,
      mkdir: io.mkdir,
      publishToInaturalist,
      readFile: io.readFile,
      resizePhoto: io.resizePhoto,
      uploadObject: (b, key, body, contentType) => io.uploadObject(client, b, key, body, contentType),
      warn: io.error,
      writeFile: io.writeFile,
    },
    { bucket, contentDir: 'src/content/photos', r2KeyPrefix, slug, sourcePath, species }
  );

  io.log(`Published ${slug}. Fill in tier/notes (and objects, if --species was omitted) in src/content/photos/${slug}.yaml`);
}
```

Then add the four new env vars to `site/.env.example`, after the existing lines:

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=photos
PUBLIC_R2_BASE_URL=
INATURALIST_APP_ID=
INATURALIST_APP_SECRET=
INATURALIST_USERNAME=
INATURALIST_PASSWORD=
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run tests/cli.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Run the full test suite**

Run: `cd site && npm test`
Expected: PASS across the whole suite (confirms Tasks 1-4 compose correctly).

- [ ] **Step 6: Commit**

```bash
git add site/scripts/lib/cli.ts site/.env.example site/tests/cli.test.ts
git commit -m "Add --species flag to publish-photo CLI"
```

At this point `publish-photo` end-to-end supports the opt-in iNaturalist flow described in the spec. The sync/freshness job is deliberately last, per the design's lower priority relative to the publish-time flow.

---

### Task 5: Sync job — backfill and refresh (LAST)

**Files:**
- Create: `site/scripts/lib/sync-inaturalist.ts`
- Create: `site/scripts/sync-inaturalist.ts`
- Create: `.github/workflows/sync-inaturalist.yml`
- Modify: `site/package.json` (add `sync-inaturalist` script)
- Test: `site/tests/sync-inaturalist.test.ts`

**Interfaces:**
- Consumes: `InaturalistCredentials`, `publishToInaturalist`, `getObservationTaxon` from Task 2; organism YAML shape from Task 3.
- Produces: `export interface SyncDeps { fetch: typeof fetch; glob: (pattern: string) => Promise<string[]>; readFile: (path: string) => Promise<string>; sleep: (ms: number) => Promise<void>; writeFile: (path: string, contents: string) => Promise<void> }`, `export interface SyncResult { changedFiles: string[] }`, `export async function syncInaturalist(deps: SyncDeps, credentials: InaturalistCredentials, contentGlob: string): Promise<SyncResult>`.

- [ ] **Step 1: Write the failing tests**

Create `site/tests/sync-inaturalist.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd site && npx vitest run tests/sync-inaturalist.test.ts`
Expected: FAIL — `../scripts/lib/sync-inaturalist` does not exist yet.

- [ ] **Step 3: Implement `site/scripts/lib/sync-inaturalist.ts`**

```ts
import {
  createObservation,
  fetchAccessToken,
  fetchJwt,
  getObservationTaxon,
  resolveTaxon,
  type InaturalistCredentials,
  type InaturalistDeps,
} from './inaturalist';

export interface SyncDeps extends InaturalistDeps {
  glob: (pattern: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
}

export interface SyncResult {
  changedFiles: string[];
}

interface OrganismMatch {
  commonName: string;
  inaturalistObservationId: number | null;
  scientificName: string;
}

const ORGANISM_BLOCK =
  /common_name: "(?<commonName>[^"]*)"\n\s+description: [^\n]*\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientific_name: "(?<scientificName>[^"]*)"/g;

function parseOrganisms(yaml: string): OrganismMatch[] {
  return [...yaml.matchAll(ORGANISM_BLOCK)].map((match) => ({
    commonName: match.groups!.commonName,
    inaturalistObservationId: match.groups!.id === 'null' ? null : Number(match.groups!.id),
    scientificName: match.groups!.scientificName,
  }));
}

/** Replaces one organism's three fields in place, matched by its current (pre-update) values. */
function replaceOrganism(yaml: string, before: OrganismMatch, after: OrganismMatch): string {
  const idText = before.inaturalistObservationId === null ? 'null' : String(before.inaturalistObservationId);
  const oldBlock = `common_name: "${before.commonName}"\n      description: null\n      inaturalistObservationId: ${idText}\n      scientific_name: "${before.scientificName}"`;
  const newIdText = after.inaturalistObservationId === null ? 'null' : String(after.inaturalistObservationId);
  const newBlock = `common_name: "${after.commonName}"\n      description: null\n      inaturalistObservationId: ${newIdText}\n      scientific_name: "${after.scientificName}"`;
  return yaml.replace(oldBlock, newBlock);
}

export async function syncInaturalist(
  deps: SyncDeps,
  credentials: InaturalistCredentials,
  contentGlob: string
): Promise<SyncResult> {
  const files = await deps.glob(contentGlob);
  const changedFiles: string[] = [];

  for (const file of files) {
    const yaml = await deps.readFile(file);
    const organisms = parseOrganisms(yaml);
    if (organisms.length === 0) continue;

    let updated = yaml;
    let changed = false;

    for (const organism of organisms) {
      if (organism.inaturalistObservationId === null) {
        // Backfill: no observation yet, create one from the stored scientific_name.
        const { commonName, taxonId } = await resolveTaxon(deps, organism.scientificName);
        const accessToken = await fetchAccessToken(deps, credentials);
        const jwt = await fetchJwt(deps, accessToken);
        const observationId = await createObservation(deps, jwt, {
          latitude: null,
          longitude: null,
          observedOn: null,
          taxonId,
        });
        updated = replaceOrganism(updated, organism, {
          commonName,
          inaturalistObservationId: observationId,
          scientificName: organism.scientificName,
        });
        changed = true;
      } else {
        // Refresh: compare the community's current taxon against what's stored.
        const taxon = await getObservationTaxon(deps, organism.inaturalistObservationId);
        if (
          taxon &&
          (taxon.scientificName !== organism.scientificName || taxon.commonName !== organism.commonName)
        ) {
          updated = replaceOrganism(updated, organism, {
            commonName: taxon.commonName,
            inaturalistObservationId: organism.inaturalistObservationId,
            scientificName: taxon.scientificName,
          });
          changed = true;
        }
      }
    }

    if (changed) {
      await deps.writeFile(file, updated);
      changedFiles.push(file);
    }

    await deps.sleep(1100);
  }

  return { changedFiles };
}
```

Note: `parseOrganisms`/`replaceOrganism` match the exact three-line shape `buildMetadataYaml` (Task 3) writes — `description: null` fixed in between. This assumes each organism's `common_name`/`inaturalistObservationId`/`scientific_name` trio within a file is unique, which holds given one organism block per photo in current usage.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd site && npx vitest run tests/sync-inaturalist.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the script entrypoint**

Create `site/scripts/sync-inaturalist.ts`:

```ts
import 'dotenv/config';
import { glob } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { syncInaturalist } from './lib/sync-inaturalist';

/* v8 ignore start -- CLI bootstrap; only runs when this file is executed directly */
if (import.meta.url === `file://${process.argv[1]}`) {
  const appId = process.env.INATURALIST_APP_ID;
  const appSecret = process.env.INATURALIST_APP_SECRET;
  const password = process.env.INATURALIST_PASSWORD;
  const username = process.env.INATURALIST_USERNAME;

  if (!appId || !appSecret || !password || !username) {
    console.error('Missing iNaturalist env vars. Copy site/.env.example to site/.env and fill it in.');
    process.exit(1);
  }

  const credentials = { appId: appId!, appSecret: appSecret!, password: password!, username: username! };

  syncInaturalist(
    {
      fetch,
      glob: async (pattern) => {
        const matches: string[] = [];
        for await (const entry of glob(pattern)) matches.push(entry);
        return matches;
      },
      readFile: (path) => readFile(path, 'utf-8'),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      writeFile: (path, contents) => writeFile(path, contents, 'utf-8'),
    },
    credentials,
    'src/content/photos/*.yaml'
  )
    .then((result) => {
      console.log(`Synced. ${result.changedFiles.length} file(s) changed: ${result.changedFiles.join(', ')}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
/* v8 ignore stop */
```

Add the script to `site/package.json`'s `"scripts"` block, alphabetically with the existing entries:

```json
    "sync-inaturalist": "tsx scripts/sync-inaturalist.ts",
```

- [ ] **Step 6: Run the full test suite**

Run: `cd site && npm test`
Expected: PASS across the whole suite.

- [ ] **Step 7: Commit the sync job**

```bash
git add site/scripts/lib/sync-inaturalist.ts site/scripts/sync-inaturalist.ts site/package.json site/tests/sync-inaturalist.test.ts
git commit -m "Add sync-inaturalist backfill/refresh job"
```

- [ ] **Step 8: Add the CI workflow**

Create `.github/workflows/sync-inaturalist.yml`:

```yaml
name: Sync iNaturalist

on:
  schedule:
    - cron: '0 13 * * *'
  workflow_dispatch: {}

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        working-directory: site
        run: npm ci

      - name: Run sync
        working-directory: site
        env:
          INATURALIST_APP_ID: ${{ secrets.INATURALIST_APP_ID }}
          INATURALIST_APP_SECRET: ${{ secrets.INATURALIST_APP_SECRET }}
          INATURALIST_USERNAME: ${{ secrets.INATURALIST_USERNAME }}
          INATURALIST_PASSWORD: ${{ secrets.INATURALIST_PASSWORD }}
        run: npm run sync-inaturalist

      - name: Commit changes
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add site/src/content/photos
          git diff --cached --quiet || git commit -m "sync: refresh iNaturalist observation data"
          git diff --quiet HEAD@{1} HEAD -- site/src/content/photos || git push
```

- [ ] **Step 9: Commit the workflow**

```bash
git add .github/workflows/sync-inaturalist.yml
git commit -m "Add daily iNaturalist sync GitHub Actions workflow"
```

## Self-Review Notes

- **Spec coverage:** schema change (Task 1), new CLI input (Task 4), `publish-photo` flow change (Task 3), sync job (Task 5), CI workflow (Task 5 step 8), credentials/.env.example (Task 4) - all covered. Testing section's four files (`inaturalist.test.ts`, `publish.test.ts` extension, `sync-inaturalist.test.ts`, schema fixtures) all covered.
- **Known deviation:** photo attachment uses a multipart buffer upload instead of a URL reference - called out in Global Constraints, since the real iNaturalist API has no "attach by URL" option. Everything else matches the approved spec.
- **Type consistency checked:** `OrganismEntry`/`publishToInaturalist`'s `{ commonName, observationId }` return shape is identical across Task 2 (`ObservationResult`), Task 3 (`PublishDeps.publishToInaturalist`'s return type), and Task 4 (the inline type alias in `cli.ts`).
