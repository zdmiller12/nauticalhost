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
