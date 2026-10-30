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

// Mirrored (not imported -- this regex is `g`-flagged and stateful via
// `lastIndex`, so sharing one instance across modules would corrupt
// interleaved matchAll/exec calls) by
// tests/photo-yaml.test.ts: 'stays matchable by sync-inaturalist ORGANISM_BLOCK'.
// Keep that copy character-for-character identical to this pattern.
const ORGANISM_BLOCK =
  /commonName: "(?<commonName>[^"]*)"\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientificName: "(?<scientificName>[^"]*)"/g;

function parseOrganisms(yaml: string): OrganismMatch[] {
  return [...yaml.matchAll(ORGANISM_BLOCK)].map((match) => ({
    commonName: match.groups!.commonName,
    inaturalistObservationId: match.groups!.id === 'null' ? null : Number(match.groups!.id),
    scientificName: match.groups!.scientificName,
  }));
}

/**
 * Replaces one organism's three sync-owned fields in place, matched by its
 * current (pre-update) values. `description` now lives outside this block
 * entirely, so the sync job no longer touches it at all.
 */
function replaceOrganism(yaml: string, before: OrganismMatch, after: OrganismMatch): string {
  const idText = before.inaturalistObservationId === null ? 'null' : String(before.inaturalistObservationId);
  const oldBlock = `commonName: "${before.commonName}"\n      inaturalistObservationId: ${idText}\n      scientificName: "${before.scientificName}"`;
  // `after.inaturalistObservationId` is always a real id here — the caller only ever
  // supplies a freshly created (backfill) or preserved (refresh) numeric id, never null.
  const newBlock = `commonName: "${after.commonName}"\n      inaturalistObservationId: ${after.inaturalistObservationId}\n      scientificName: "${after.scientificName}"`;
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

    console.log(`[sync-inaturalist] ${file}: ${organisms.length} organism(s)`);
    let updated = yaml;
    let fileChanged = false;

    for (const organism of organisms) {
      try {
        if (organism.inaturalistObservationId === null) {
          // Backfill: no observation yet, create one from the stored scientificName.
          console.log(`[sync-inaturalist] ${file}: backfilling "${organism.scientificName}"`);
          const { commonName, taxonId } = await resolveTaxon(deps, organism.scientificName);
          const accessToken = await fetchAccessToken(deps, credentials);
          const jwt = await fetchJwt(deps, accessToken);
          const observation = await createObservation(deps, jwt, {
            latitude: null,
            longitude: null,
            observedOn: null,
            taxonId,
          });
          updated = replaceOrganism(updated, organism, {
            commonName,
            inaturalistObservationId: observation.id,
            scientificName: organism.scientificName,
          });
          // Persisted immediately: the observation now exists on iNaturalist, so its
          // id must be written to disk before touching the next organism -- otherwise
          // a later failure in this same file would orphan it and a future run would
          // create a duplicate.
          await deps.writeFile(file, updated);
          fileChanged = true;
          console.log(`[sync-inaturalist] ${file}: created observation ${observation.id} for "${organism.scientificName}"`);
        } else {
          // Refresh: compare the community's current taxon against what's stored.
          console.log(`[sync-inaturalist] ${file}: refreshing observation ${organism.inaturalistObservationId} ("${organism.scientificName}")`);
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
            await deps.writeFile(file, updated);
            fileChanged = true;
            console.log(
              `[sync-inaturalist] ${file}: observation ${organism.inaturalistObservationId} updated to "${taxon.scientificName}" ("${taxon.commonName}")`
            );
          } else {
            console.log(`[sync-inaturalist] ${file}: observation ${organism.inaturalistObservationId} unchanged`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[sync-inaturalist] ${file} / "${organism.scientificName}": ${message}`);
      }

      await deps.sleep(1100);
    }

    if (fileChanged) changedFiles.push(file);
  }

  return { changedFiles };
}
