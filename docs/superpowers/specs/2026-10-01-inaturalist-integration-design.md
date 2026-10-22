# iNaturalist Integration — Design

## Goal

Attach an iNaturalist observation to each photo of an organism, so the community identification process can verify/correct the site's species data over time, and so each photo can link to its public iNaturalist observation page.

## Context

- `site/scripts/publish-photo.ts` → `site/scripts/lib/cli.ts` (`runCli`) → `site/scripts/lib/publish.ts` (`publishPhoto`) currently takes only `sourcePath` and `r2KeyPrefix`. It extracts EXIF, uploads two sizes to R2, then calls `buildMetadataYaml` to write `{contentDir}/{slug}.yaml`. **There is currently no CLI input for species at all** — `buildMetadataYaml` emits the `objects:` block as a commented-out placeholder, hand-filled after publishing.
- `photoSchema` (`site/src/content/schema.ts`) has no per-photo or per-object external-ID field. `photoObjectSchema` is a discriminated union with exactly two variants: `landmark` (`details.description`) and `organism` (`details.common_name`, `details.description`, `details.scientific_name`). Species identification is per-*object*, not per-photo — a photo can contain multiple organisms, each independently identifiable on iNaturalist.
- The user already has an initial species guess *before* running `publish-photo` (unlike landmark/notes/rating, which are still filled in by hand afterward).
- YAML files are edited via regex/string-concat (see `site/scripts/lib/backfill-exif-other.ts`), not full parse-and-reserialize with `js-yaml` — this preserves hand-written comments and formatting. Any new code touching existing YAML files must follow this convention.
- No `config.ts` abstraction exists; env vars are read directly off `io.env` in `cli.ts` with explicit missing-var checks, loaded via `dotenv/config` in the script entrypoint (see `site/.env.example`). No `.github/` directory exists yet in this repo — a scheduled sync workflow is the first GitHub Actions workflow.
- Tests live under `site/tests/`, one file per `lib/*.ts` module, using dependency-injection interfaces (`PublishDeps`, `BackfillDeps`) for mocking IO/network.

## iNaturalist API

- REST API at `https://api.inaturalist.org/v2`. Docs: `https://api.inaturalist.org/v2/docs/`. v2 is a sparse-fieldset API: every response is `{ id }`-only unless a `fields` query param is supplied, using the `(field:!t,nested:(field:!t))` syntax — v1's "return everything" default no longer applies.
- `GET /v2/taxa?q=<name>&fields=...` and `GET /v2/observations?id=<id>&fields=...` (collection endpoint, filtered by `id`) are unauthenticated. v2 dropped the v1 `GET /observations/{id}` path form in favor of path-by-`uuid` (`GET /v2/observations/{uuid}`) or filtering the collection endpoint by the stored numeric `id` — this codebase uses the latter so the stored `inaturalistObservationId` can stay a plain number.
- Writes still need an OAuth app (registered once at `inaturalist.org/oauth/applications`) → password-grant exchange for an access token → exchange that for a short-lived JWT via `POST /v1/users/api_token` (expires in 24h, **v1-only — v2 has no equivalent endpoint**, but the JWT it returns authenticates v2 write calls the same way) → `Authorization: Bearer <jwt>` header on write calls.
- `POST /v2/observations?fields=(id:!t,uuid:!t)` creates an observation (`taxon_id`, `observed_on`, `latitude`/`longitude`, `description`) and responds `{ results: [{ id, uuid }] }` (v1 responded with the bare object; v2 wraps every response in `results`). `POST /v2/observation_photos` attaches an already-uploaded photo (multipart) to an observation — keyed by `observation_photo[observation_id]`, which in v2 must be the observation's **uuid**, not its integer `id`.
- Rate limit guidance: ~1 request/second, 10,000/day. Both the publish-time call and the sync job stay well under this for a personal photo library.

## Schema change

Add `inaturalistObservationId` to the `organism` variant of `photoObjectSchema` only (landmarks have no taxon, so no observation):

```ts
z.object({
  details: z.object({
    commonName: z.string(),
    description: z.string().nullable(),
    inaturalistObservationId: z.number().nullable().default(null),
    scientificName: z.string(),
  }),
  objectType: z.literal('organism'),
}),
```

Field inserted alphabetically among `details`, matching existing schema convention. Nullable/defaulted so existing published photos (and any publish that fails to reach iNaturalist) remain valid without a backfill migration.

## New CLI input

`publish-photo` gains an optional third argument carrying the initial species guess, e.g.:

```
npm run publish-photo -- <sourcePath> <r2KeyPrefix> --species "Pandion haliaetus"
```

Threaded through `PublishArgs`/`CliIo` into `publishPhoto()` alongside the existing two args. If omitted, behavior is unchanged from today (commented `objects:` placeholder, no iNaturalist call) — this keeps the feature opt-in per photo and doesn't force every publish through a network dependency.

## `publish-photo` flow change

When `--species` is provided, after the existing EXIF extraction and R2 upload (unchanged), `publishPhoto` calls a new `lib/inaturalist.ts` module:

1. `GET /v2/taxa?q=<species>&fields=(id:!t,preferred_common_name:!t)` to resolve the scientific name to a `taxon_id` and pull `preferred_common_name` (auto-fills `commonName` — the user only has to type the scientific name they already know, not re-type the common name).
2. Fetch a fresh JWT (`POST /v1/users/api_token` — no v2 equivalent; see API section above).
3. `POST /v2/observations?fields=(id:!t,uuid:!t)` with `taxon_id`, `observed_on` (from EXIF `datetime`), `latitude`/`longitude` (from EXIF, when present). Response gives both the integer `id` (stored on the photo) and `uuid` (needed for the next step).
4. `POST /v2/observation_photos` attaching the already-uploaded lightbox image bytes (multipart `file`) to the new observation, keyed by its `uuid` from step 3.
5. Returns `{ observationId, commonName }` (the integer id — or a failure) to `publishPhoto`.

`buildMetadataYaml` then writes an actual `organism` entry (not the commented placeholder) with `scientificName` (user-provided), `commonName` (from iNat, or empty string if the iNat call failed), `description: null`, and `inaturalistObservationId` (from iNat, or `null` on failure).

**Failure handling:** any step above failing (network, taxon not found, auth) is caught, logged as a warning, and `publishPhoto` continues — the YAML still gets written, with `inaturalistObservationId: null`. A photo is never blocked from publishing by iNaturalist being unavailable. The nightly sync job (below) picks up and retries photos missing an ID.

## Sync job (freshness)

A new script, `site/scripts/sync-inaturalist.ts` → `lib/sync-inaturalist.ts` (`SyncDeps`, mirroring the existing DI pattern), run on a daily GitHub Actions cron:

1. Glob `site/src/content/photos/*.yaml`. For each file, regex-extract any `organism` object blocks (same string-based editing approach as `backfill-exif-other.ts` — no full YAML reserialize, to preserve comments/formatting).
2. **Backfill case** — `scientificName` present, `inaturalistObservationId` is `null`: retry the same create-observation flow used in `publish-photo` (handles photos published while iNaturalist was down, or published before this feature existed).
3. **Refresh case** — `inaturalistObservationId` present: `GET /v2/observations?id=<id>&fields=(taxon:(name:!t,preferred_common_name:!t))` (unauthenticated), compare the community's current taxon name against the stored `scientificName`/`commonName`. If they differ, overwrite both fields in place (regex replace) — per explicit decision, **silently**, no manual-review gate.
4. Sleep briefly between requests to stay under the ~1 req/sec guidance.
5. Any files changed are left modified in the working tree; the GitHub Actions workflow commits and pushes them (`git add -A && git commit -m "sync: refresh iNaturalist observation data" && git push`, skipped if there's nothing to commit).

## Credentials

- New env vars: `INATURALIST_APP_ID`, `INATURALIST_APP_SECRET`, `INATURALIST_USERNAME`, `INATURALIST_PASSWORD` (password-grant OAuth, matching iNat's documented flow for first-party scripts). Added to `site/.env.example` alongside the existing `R2_*` vars, read directly off `io.env` with the same explicit missing-var check pattern as `cli.ts` already uses — no new config abstraction introduced.
- For local `publish-photo` runs: `.env` (already gitignored, same as today).
- For the GitHub Actions workflow: the same four values stored as repository secrets, injected as workflow env vars.

## CI workflow

`.github/workflows/sync-inaturalist.yml` (first workflow in this repo) — scheduled daily (e.g. `cron: '0 13 * * *'`), checks out the repo, installs deps, runs `npm run sync-inaturalist` inside `site/`, commits and pushes any changed YAML files using the repo's default `GITHUB_TOKEN`.

## Testing

- `site/tests/inaturalist.test.ts`: unit tests for the new `lib/inaturalist.ts` module (taxon resolution, observation creation, photo attachment) using injected fake HTTP deps, following the existing `PublishDeps`-style mocking pattern.
- `site/tests/publish.test.ts`: extend with a case covering the `--species` flag — successful iNat call populates `objects`/`inaturalistObservationId`; a failing iNat call still produces valid YAML with `inaturalistObservationId: null`.
- `site/tests/sync-inaturalist.test.ts`: new file covering the backfill case, the refresh/overwrite case, and the no-op case (nothing to update), using fixture YAML strings and injected fake HTTP deps.
- Schema test pattern (existing Zod fixture tests) extended with a valid/invalid fixture for the new `inaturalistObservationId` field.

## Explicitly out of scope for this pass

- Bidirectional sync (posting identifications/comments back to iNaturalist from the site).
- A manual-review/flagging UI for contested community IDs — explicitly decided to auto-update silently instead.
- Rendering the iNaturalist link or "research grade" badge on the photo page itself (follow-on UI work once the data is flowing; this pass is data-layer only).
- Taxonomy/phylogeny data beyond `scientific_name`/`common_name` — still out of scope per the existing photo-compendium design.
