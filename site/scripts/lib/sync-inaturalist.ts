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
  description: string;
  inaturalistObservationId: number | null;
  scientificName: string;
}

// Mirrored (not imported -- this regex is `g`-flagged and stateful via
// `lastIndex`, so sharing one instance across modules would corrupt
// interleaved matchAll/exec calls) by
// tests/photo-yaml.test.ts: 'stays matchable by sync-inaturalist ORGANISM_BLOCK'.
// Keep that copy character-for-character identical to this pattern.
const ORGANISM_BLOCK =
  /commonName: "(?<commonName>[^"]*)"\n\s+description: (?<description>[^\n]*)\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientificName: "(?<scientificName>[^"]*)"/g;

function parseOrganisms(yaml: string): OrganismMatch[] {
  return [...yaml.matchAll(ORGANISM_BLOCK)].map((match) => ({
    commonName: match.groups!.commonName,
    description: match.groups!.description,
    inaturalistObservationId: match.groups!.id === 'null' ? null : Number(match.groups!.id),
    scientificName: match.groups!.scientificName,
  }));
}

/**
 * Replaces one organism's three sync-owned fields in place, matched by its
 * current (pre-update) values. `description` is carried across verbatim --
 * the sync job owns commonName/inaturalistObservationId/scientificName and
 * nothing else, and the block is rebuilt as a literal string for
 * `String.replace`, so any field it does not echo back it would silently
 * clobber.
 */
function replaceOrganism(yaml: string, before: OrganismMatch, after: OrganismMatch): string {
  const idText = before.inaturalistObservationId === null ? 'null' : String(before.inaturalistObservationId);
  const oldBlock = `commonName: "${before.commonName}"\n      description: ${before.description}\n      inaturalistObservationId: ${idText}\n      scientificName: "${before.scientificName}"`;
  // `after.inaturalistObservationId` is always a real id here — the caller only ever
  // supplies a freshly created (backfill) or preserved (refresh) numeric id, never null.
  const newBlock = `commonName: "${after.commonName}"\n      description: ${before.description}\n      inaturalistObservationId: ${after.inaturalistObservationId}\n      scientificName: "${after.scientificName}"`;
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
        // Backfill: no observation yet, create one from the stored scientificName.
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
          description: organism.description,
          inaturalistObservationId: observation.id,
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
            description: organism.description,
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
