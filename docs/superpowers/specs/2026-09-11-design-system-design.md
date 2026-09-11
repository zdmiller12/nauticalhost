# Design System — Design

## Goal

Give the personal site (currently unstyled — no CSS framework, no design tokens, plain
semantic HTML) a cohesive, modern-minimalist visual design, structured so the token
layer can be lifted out and shared with other repos later, when this site grows into a
micro-frontend-style setup (independently deployed Cloudflare Workers, mixed
public/private repos, stitched under one domain).

## Context

- Site: static Astro 7 app (`site/`), no CSS framework installed, deployed as a
  Cloudflare Worker via `@astrojs/cloudflare` + `wrangler deploy` (Workers Builds, not
  Pages).
- Current pages: Home (hero + timeline), Projects (`ProjectCard` list from a Zod-typed
  content collection), Resume, Compendium (photo grid with client-side sort, from the
  photo content collection — see `2026-09-02-photo-compendium-design.md`). None of the
  four pages, nor `Header`/`Footer`/`BaseLayout`/`ProjectCard`, have any CSS today.
- Inspiration: [Astro Starter Portfolio](https://astro.build/themes/details/astro-starter-portfolio/)
  — chosen as a reference (not a fork) for its "one accent color + design tokens
  drive everything" philosophy, which fits the cross-repo sharing goal better than
  adopting a full theme's component tree.
- Cross-repo sharing is a stated future goal but has no second repo yet — the actual
  distribution mechanism (npm package, git submodule, manual copy) is explicitly
  deferred (YAGNI) until a second consumer exists to validate real requirements. This
  design only ensures the token layer is *shaped* so that extraction later is a
  copy of one file, not an untangling exercise.

## Decision: borrow the design language, not the theme repo

Rejected forking/adopting any of the four reference themes wholesale. Reasons: each is
a monolithic component tree with its own opinions on markup/structure; adopting one
would fight the goal of a small, ownable token layer other repos can consume, and
would pull in Tailwind config patterns (`tailwind.config.js`-style) that don't match
this site's Tailwind v4 CSS-first approach.

## Visual language

- **Palette:** earthy and muted. Neutrals: paper (`#FAF6EF` light bg / dark equivalent)
  and ink (`#2B2823` light text / dark equivalent). **Clay (`#B5654A`) is the single UI
  accent** — the only color used for links, buttons, active states, and hover states.
  Four additional tokens (amber `#C99A4A`, slate `#5C6B73`, sage `#8A9A6E`, lavender
  `#8D7A93`) are defined but **not** wired into general UI chrome — reserved for data
  visualization, and only the sage ramp is used in this pass (see Photo tier below).
  This was chosen over spreading all five hues across UI elements (tags, section
  tints) to keep the interface restrained; tags stay neutral gray.
- **Typography:** a single system-font stack (`-apple-system, "Segoe UI", Roboto, …`),
  varied by weight, not a self-hosted webfont. Chosen over self-hosting (e.g. Inter/Geist
  via the Astro Fonts API) because: it has zero build-time dependency, zero
  extra network request, and critically, it's trivially portable to other repos in the
  future micro-frontend setup (one CSS string, no font-file distribution problem). The
  visual cost is small — system UI fonts in 2026 already read as clean and modern at
  body-text sizes.
- **Type scale:** 12 / 14 / 16 / 20 / 24 / 32 / 40 px. Tight line-height for headings,
  relaxed for body copy.
- **Spacing:** Tailwind v4's default spacing scale, unmodified — no bespoke spacing
  tokens. Fewer custom values to maintain, and the default scale is already sensible
  at this site's size.
- **Card style:** bordered/shadowed cards (subtle border + soft shadow) for both
  `ProjectCard` and the new `PhotoCard` — chosen over borderless/whitespace-only for
  clearer separation in a photo grid with varying image content.
- **Dark mode:** class-based (`.dark` on `<html>`), toggled via a small inline script
  in `BaseLayout` that reads `localStorage` first, falls back to
  `prefers-color-scheme`, and runs before paint to avoid a flash of the wrong theme. A
  toggle button lives in the `Header`.

## Token architecture

All tokens live in one new file, `site/src/styles/global.css`, using Tailwind v4's
CSS-first config (`@import "tailwindcss";` + an `@theme` block) — no
`tailwind.config.js`. This file *is* the reusable design-token layer: extracting the
design system into a shared package later means copying this one file, not untangling
it from a theme's component internals. Dark-mode token overrides live in the same file
under a `.dark` selector block, following Tailwind v4's standard dark-mode pattern.

## Components

- **`Header`** — site name, nav links (Home / Projects / Compendium / Resume), dark-mode
  toggle button. Hairline bottom border; active nav link underlined in clay.
- **`Footer`** — social links row (from existing `social-links.ts`) + copyright line, in
  a muted secondary-ink tone, hairline top border.
- **`BaseLayout`** — adds the dark-mode init script (head, before paint), a centered
  content column, and consistent vertical rhythm via Tailwind spacing utilities on
  `<main>`.
- **Home (`index.astro`)** — hero section (headshot, name, one-liner) and timeline,
  restyled with clay-colored year markers on the timeline.
- **`ProjectCard`** — bordered/shadowed card; neutral-gray tag chips; clay-colored
  links (GitHub / demo).
- **`PhotoCard` (new component)** — extracted from the inline `<li class="photo-card">`
  markup currently embedded directly in `compendium.astro`, mirroring the
  `ProjectCard` pattern for consistency. Renders the thumbnail, date, tier badge, and
  object list (species/landmark chips, neutral gray).
- **`compendium.astro`** — updated to render `PhotoCard` per photo instead of inline
  markup; sort `<select>` control gets minimal styling to match the rest of the UI.
- **`resume.astro`** — restyled with the same section/heading conventions as the rest
  of the site; no structural change.

## Photo tier color treatment

`tier` is an ordinal scale (`S, A, B, C, D, E, F` — see `schema.ts`), not a category.
Rather than spreading the four reserved data-viz hues across seven ranks (a cardinality
mismatch that would imply false categorical distinctions), the tier badge uses a
**single-hue intensity ramp on sage** — most saturated/darkest at `S`, fading toward a
muted neutral gray at `F`. Amber, slate, and lavender tokens remain defined but unused
until a future feature actually needs a categorical (not ordinal) data color — no
forced use just to spend the palette.

## Testing

No new test infrastructure. This is a markup/CSS-only change — the existing Vitest
suite (`photo-sort.ts`, content schema tests) is unaffected and stays as-is. Verification
is manual: run `astro dev`, check every page in both light and dark mode, and at mobile
width (~400px), before calling the work done.

## Explicitly out of scope for this pass

- The actual cross-repo token distribution mechanism (npm package vs. git submodule vs.
  manual copy). Deferred until a second repo exists to consume it — see Context above.
- Any content/copy changes beyond what's needed to fit the new visual system (e.g., no
  new bio text, no new project entries).
- Automated visual regression testing.
- Using the amber/slate/lavender data-viz tokens for anything — they're reserved, not
  wired in, this pass.
