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
  privateLocation?: boolean;
  species: string;
}

export interface ObservationResult {
  commonName: string;
  observationId: number;
}

const API_BASE = 'https://api.inaturalist.org/v2';
// The JWT exchange endpoint (`/users/api_token`) lives on the main site, not
// the api.inaturalist.org host; the JWT it returns authenticates v2 write
// endpoints just the same.
const JWT_EXCHANGE_URL = 'https://www.inaturalist.org/users/api_token';

/** Formats a failed response's status alongside its body, so API-rejection reasons (e.g. validation errors) aren't lost. */
async function describeFailure(res: Response): Promise<string> {
  const text = await res.text();
  return text ? `${res.status} ${text}` : `${res.status}`;
}

export async function resolveTaxon(
  deps: InaturalistDeps,
  species: string
): Promise<{ commonName: string; taxonId: number }> {
  const fields = encodeURIComponent('(id:!t,preferred_common_name:!t)');
  const res = await deps.fetch(`${API_BASE}/taxa?q=${encodeURIComponent(species)}&fields=${fields}`);
  if (!res.ok) throw new Error(`iNaturalist taxon lookup failed: ${await describeFailure(res)}`);
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
  if (!res.ok) throw new Error(`iNaturalist OAuth token request failed: ${await describeFailure(res)}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export async function fetchJwt(deps: InaturalistDeps, accessToken: string): Promise<string> {
  const res = await deps.fetch(JWT_EXCHANGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`iNaturalist JWT request failed: ${await describeFailure(res)}`);
  const body = (await res.json()) as { api_token: string };
  return body.api_token;
}

export async function createObservation(
  deps: InaturalistDeps,
  jwt: string,
  args: {
    latitude: number | null;
    longitude: number | null;
    observedOn: Date | null;
    privateLocation?: boolean;
    taxonId: number;
  }
): Promise<{ id: number; uuid: string }> {
  const fields = encodeURIComponent('(id:!t,uuid:!t)');
  const res = await deps.fetch(`${API_BASE}/observations?fields=${fields}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      observation: {
        // 'private' hides the coordinates from everyone but the observer; iNaturalist still stores them.
        geoprivacy: args.privateLocation ? 'private' : undefined,
        latitude: args.latitude,
        longitude: args.longitude,
        observed_on_string: args.observedOn ? args.observedOn.toISOString() : undefined,
        taxon_id: args.taxonId,
      },
    }),
  });
  if (!res.ok) throw new Error(`iNaturalist observation creation failed: ${await describeFailure(res)}`);
  const body = (await res.json()) as { results: Array<{ id: number; uuid: string }> };
  return body.results[0];
}

export async function attachPhoto(
  deps: InaturalistDeps,
  jwt: string,
  observationUuid: string,
  photo: Buffer
): Promise<void> {
  const form = new FormData();
  form.append('observation_photo[observation_id]', observationUuid);
  form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');

  const res = await deps.fetch(`${API_BASE}/observation_photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`iNaturalist photo attach failed: ${await describeFailure(res)}`);
}

export async function publishToInaturalist(
  deps: InaturalistDeps,
  credentials: InaturalistCredentials,
  input: ObservationInput
): Promise<ObservationResult> {
  const { commonName, taxonId } = await resolveTaxon(deps, input.species);
  const accessToken = await fetchAccessToken(deps, credentials);
  const jwt = await fetchJwt(deps, accessToken);
  const observation = await createObservation(deps, jwt, {
    latitude: input.latitude,
    longitude: input.longitude,
    observedOn: input.observedOn,
    privateLocation: input.privateLocation,
    taxonId,
  });
  await attachPhoto(deps, jwt, observation.uuid, input.photo);
  return { commonName, observationId: observation.id };
}

export async function getObservationTaxon(
  deps: InaturalistDeps,
  observationId: number
): Promise<{ commonName: string; scientificName: string } | null> {
  const fields = encodeURIComponent('(taxon:(name:!t,preferred_common_name:!t))');
  const res = await deps.fetch(`${API_BASE}/observations?id=${observationId}&fields=${fields}`);
  if (!res.ok) throw new Error(`iNaturalist observation lookup failed: ${await describeFailure(res)}`);
  const body = (await res.json()) as {
    results: Array<{ taxon: { name: string; preferred_common_name?: string } | null }>;
  };
  const taxon = body.results[0]?.taxon;
  if (!taxon) return null;
  return { commonName: taxon.preferred_common_name ?? '', scientificName: taxon.name };
}
