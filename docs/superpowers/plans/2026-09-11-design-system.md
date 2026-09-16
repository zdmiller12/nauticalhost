# Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Restyle the personal site with a cohesive, modern-minimalist design system (earthy/clay palette, system-font stack, Tailwind v4 tokens) built as a single reusable token layer, per `docs/superpowers/specs/2026-09-11-design-system-design.md`.

**Architecture:** Add Tailwind v4 (CSS-first `@theme` config, no `tailwind.config.js`) with all design tokens defined in one new file, `site/src/styles/global.css`. Every existing component/page/layout is restyled in place using Tailwind utility classes generated from those tokens; one new component (`PhotoCard`) is extracted from inline markup in `compendium.astro` to match the existing `ProjectCard` pattern.

**Tech Stack:** Astro 7, Tailwind CSS v4 (`tailwindcss` + `@tailwindcss/vite`), TypeScript, Vitest (existing suite, unchanged).

**Spec:** `docs/superpowers/specs/2026-09-11-design-system-design.md`

## Global Constraints

- Tailwind v4 CSS-first config only — no `tailwind.config.js` file.
- Clay (`#b5654a` light / `#c97a5e` dark) is the **only** color wired into general UI (links, buttons, active/hover states). Amber/slate/sage/lavender tokens are defined but stay unused outside the sage-based photo-tier ramp.
- Typography is the system-font stack only — no self-hosted webfonts.
- Use Tailwind's default spacing scale, unmodified — no bespoke spacing tokens.
- No new test infrastructure. Verification is manual (`astro dev`, checked in browser) plus re-running the existing Vitest suite where a task touches code the suite covers.
- Node `>=22.12.0` (per `site/package.json` `engines`) must keep building.
- All work happens on branch `worktree-design-system` (already checked out in the active worktree). Each task ends with its own commit.

---

### Task 1: Install Tailwind v4 and define the design-token layer

**Files:**
- Modify: `site/package.json` (adds `tailwindcss`, `@tailwindcss/vite`)
- Modify: `site/astro.config.mjs`
- Create: `site/src/styles/global.css`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: Tailwind utility classes generated from theme tokens, used by every later task —
  `bg-paper`, `text-paper`, `text-ink`, `text-ink-muted`, `bg-ink-muted`, `border-line`,
  `bg-line`, `text-clay`, `bg-clay`, `bg-tier-s` … `bg-tier-f`, `font-sans`, and
  overridden sizes `text-lg`/`text-xl`/`text-2xl`/`text-3xl`. A `.dark` class on
  `<html>` re-resolves `paper`/`ink`/`ink-muted`/`line`/`clay` to their dark-mode
  values — later tasks rely on this contract without redefining it.

- [x] **Step 1: Install Tailwind v4 packages**

Run (from `site/`):
```bash
cd site && npm install tailwindcss@^4 @tailwindcss/vite@^4
```
Expected: `package.json` now lists `tailwindcss` and `@tailwindcss/vite` under `dependencies`.

- [x] **Step 2: Wire the Tailwind Vite plugin into Astro config**

Replace the full contents of `site/astro.config.mjs` with:

```js
// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // This is a fully static site with no <Image> usage and no Astro sessions,
  // so skip the Cloudflare Images/KV bindings the adapter provisions by default.
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  vite: {
    plugins: [tailwindcss()],
  },
});
```

- [x] **Step 3: Create the token file**

Create `site/src/styles/global.css`:

```css
@import "tailwindcss";

@theme {
  /* Fonts — system stack only, no self-hosted webfonts */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
    sans-serif, "Apple Color Emoji", "Segoe UI Emoji";

  /* Type scale (12/14/16/20/24/32/40px). xs/sm/base already match Tailwind's
     defaults; only lg/xl/2xl/3xl need overriding. */
  --text-lg: 1.25rem;
  --text-xl: 1.5rem;
  --text-2xl: 2rem;
  --text-3xl: 2.5rem;

  /* Neutrals (light mode default) */
  --color-paper: #faf6ef;
  --color-ink: #2b2823;
  --color-ink-muted: #6b655a;
  --color-line: #e4dcc9;

  /* Accent — the only color used for links, buttons, active/hover states */
  --color-clay: #b5654a;

  /* Reserved data-viz hues — not wired into general UI this pass */
  --color-amber: #c99a4a;
  --color-slate: #5c6b73;
  --color-sage: #8a9a6e;
  --color-lavender: #8d7a93;

  /* Photo tier ordinal ramp, S (best) -> F (worst) */
  --color-tier-s: #5f7a4a;
  --color-tier-a: #748a5c;
  --color-tier-b: #8a9a6e;
  --color-tier-c: #9fa98c;
  --color-tier-d: #b4b8a6;
  --color-tier-e: #c7c7be;
  --color-tier-f: #d8d4c8;
}

.dark {
  --color-paper: #211e1a;
  --color-ink: #ede8de;
  --color-ink-muted: #b8b0a0;
  --color-line: #3a352c;
  --color-clay: #c97a5e;
}
```

- [x] **Step 4: Verify the build compiles the tokens**

Run:
```bash
cd site && npm run build
```
Expected: build succeeds, then:
```bash
grep -r "b5654a" site/dist/_astro/*.css
```
returns at least one match, confirming the token compiled into the output CSS.

- [x] **Step 5: Commit**

```bash
git add site/package.json site/package-lock.json site/astro.config.mjs site/src/styles/global.css
git commit -m "Add Tailwind v4 and design-token layer"
```

---

### Task 2: Wire tokens into BaseLayout and add dark-mode init

**Files:**
- Modify: `site/src/layouts/BaseLayout.astro`

**Interfaces:**
- Consumes: `global.css` utilities from Task 1 (`bg-paper`, `text-ink`, `font-sans`).
- Produces: the dark-mode contract every later task's toggle/consumer relies on —
  an inline `<head>` script reads `localStorage.getItem('theme')` (values `'dark'` /
  `'light'`), falls back to `prefers-color-scheme`, and adds/removes the class
  `dark` on `document.documentElement`. Any toggle control must read/write the same
  `'theme'` key and target the same element to stay compatible. Also produces the
  page content-column convention: `<main>` carries `mx-auto max-w-3xl px-4 py-12` —
  pages render inside it and don't need their own width styling.

- [x] **Step 1: Replace BaseLayout.astro**

Replace the full contents of `site/src/layouts/BaseLayout.astro`:

```astro
---
import Header from '../components/Header.astro';
import Footer from '../components/Footer.astro';
import '../styles/global.css';

interface Props {
  title: string;
  description?: string;
}

const { title, description = 'Zack Miller — engineer, builder.' } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <title>{title} · Zack Miller</title>
    <script is:inline>
      const stored = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (stored === 'dark' || (!stored && prefersDark)) {
        document.documentElement.classList.add('dark');
      }
    </script>
  </head>
  <body class="min-h-screen bg-paper font-sans text-ink">
    <Header />
    <main class="mx-auto max-w-3xl px-4 py-12">
      <slot />
    </main>
    <Footer />
  </body>
</html>
```

- [x] **Step 2: Verify no flash-of-wrong-theme and base colors apply**

Run (from `site/`):
```bash
astro dev --background
```
Open the site in a browser with OS dark mode on: the page background should render
dark on first load (no flash of a light page before it switches). Toggle OS theme and
reload: it should follow `prefers-color-scheme` since no `theme` key is in
`localStorage` yet. Then run `astro dev stop`.

- [x] **Step 3: Commit**

```bash
git add site/src/layouts/BaseLayout.astro
git commit -m "Wire design tokens and dark-mode init into BaseLayout"
```

---

### Task 3: Restyle Header with nav active-state and dark-mode toggle

**Files:**
- Modify: `site/src/components/Header.astro`

**Interfaces:**
- Consumes: Task 2's dark-mode contract (`localStorage['theme']`,
  `document.documentElement.classList`), Task 1's tokens (`border-line`, `text-clay`,
  `text-ink-muted`).
- Produces: `#theme-toggle` button (click target for dark-mode toggle); nav
  active-link convention (`text-clay underline underline-offset-4` when the link's
  `href` matches `Astro.url.pathname`).

- [x] **Step 1: Replace Header.astro**

Replace the full contents of `site/src/components/Header.astro`:

```astro
---
const path = Astro.url.pathname;
const linkClass = (href: string) =>
  path === href ? 'text-clay underline underline-offset-4' : 'hover:text-clay';
---
<header class="border-b border-line">
  <nav class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 text-sm">
    <div class="flex gap-6">
      <a href="/" class={linkClass('/')}>Home</a>
      <a href="/projects" class={linkClass('/projects')}>Projects</a>
      <a href="/compendium" class={linkClass('/compendium')}>Compendium</a>
      <a href="/resume" class={linkClass('/resume')}>Resume</a>
    </div>
    <button
      id="theme-toggle"
      type="button"
      aria-label="Toggle dark mode"
      class="text-ink-muted hover:text-clay"
    >
      🌓
    </button>
  </nav>
</header>
<script>
  const button = document.getElementById('theme-toggle');
  button?.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
</script>
```

- [x] **Step 2: Verify the toggle and active state**

Run `astro dev --background`, open the site. Click the 🌓 button: the page should
flip between light and dark instantly and persist across a reload (check
`localStorage.theme` in devtools). Navigate to `/projects`: the "Projects" link
should be clay-colored and underlined while the others aren't. Run `astro dev stop`.

- [x] **Step 3: Commit**

```bash
git add site/src/components/Header.astro
git commit -m "Restyle Header with active nav state and dark-mode toggle"
```

---

### Task 4: Restyle Footer

**Files:**
- Modify: `site/src/components/Footer.astro`

**Interfaces:**
- Consumes: `socialLinks: {label: string; url: string}[]` from
  `site/src/data/social-links.ts` (existing, unchanged); Task 1 tokens
  (`border-line`, `text-ink-muted`, `text-clay`).
- Produces: nothing new consumed elsewhere.

- [x] **Step 1: Replace Footer.astro**

Replace the full contents of `site/src/components/Footer.astro`:

```astro
---
import { socialLinks } from '../data/social-links';
---
<footer class="border-t border-line">
  <div class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-ink-muted">
    <nav class="flex gap-4">
      {socialLinks.map((link) => (
        <a href={link.url} class="hover:text-clay">{link.label}</a>
      ))}
    </nav>
    <p>&copy; {new Date().getFullYear()} Zack Miller</p>
  </div>
</footer>
```

- [x] **Step 2: Verify**

Run `astro dev --background`, confirm the footer shows GitHub/LinkedIn/Email links
with a hairline top border, links turn clay on hover, and the copyright line sits at
the right edge on desktop width. Run `astro dev stop`.

- [x] **Step 3: Commit**

```bash
git add site/src/components/Footer.astro
git commit -m "Restyle Footer"
```

---

### Task 5: Restyle ProjectCard and the Projects page

**Files:**
- Modify: `site/src/components/ProjectCard.astro`
- Modify: `site/src/pages/projects.astro`

**Interfaces:**
- Consumes: `CollectionEntry<'projects'>` (existing schema, unchanged); Task 1 tokens
  (`border-line`, `bg-paper`, `text-clay`, `bg-line`, `text-ink-muted`).
- Produces: nothing new consumed elsewhere.

- [x] **Step 1: Replace ProjectCard.astro**

Replace the full contents of `site/src/components/ProjectCard.astro`:

```astro
---
import type { CollectionEntry } from 'astro:content';

interface Props {
  project: CollectionEntry<'projects'>;
}

const { project } = Astro.props;
const { title, description, githubUrl, demoUrl, tags } = project.data;
---
<article class="mb-6 rounded-lg border border-line bg-paper p-6 shadow-sm">
  <h2 class="text-xl font-semibold">{title}</h2>
  <p class="mt-2 text-ink-muted">{description}</p>
  <ul class="mt-4 flex flex-wrap gap-2">
    {tags.map((tag) => (
      <li class="rounded-full bg-line/50 px-3 py-1 text-xs text-ink-muted">{tag}</li>
    ))}
  </ul>
  <div class="mt-4 flex gap-4 text-sm">
    <a href={githubUrl} class="text-clay hover:opacity-75">GitHub</a>
    {demoUrl && <a href={demoUrl} class="text-clay hover:opacity-75">Live demo</a>}
  </div>
</article>
```

- [x] **Step 2: Update projects.astro's heading**

Replace the full contents of `site/src/pages/projects.astro`:

```astro
---
import { getCollection } from 'astro:content';
import BaseLayout from '../layouts/BaseLayout.astro';
import ProjectCard from '../components/ProjectCard.astro';

const projects = (await getCollection('projects')).sort(
  (a, b) => a.data.order - b.data.order
);
---
<BaseLayout title="Projects" description="Projects by Zack Miller.">
  <h1 class="text-2xl font-semibold">Projects</h1>
  <div class="mt-6">
    {projects.map((project) => <ProjectCard project={project} />)}
  </div>
</BaseLayout>
```

- [x] **Step 3: Verify**

Run `astro dev --background`, open `/projects`: both project cards should show as
bordered/shadowed cards with gray tag chips and clay-colored links, in both light and
dark mode. Run `astro dev stop`.

- [x] **Step 4: Commit**

```bash
git add site/src/components/ProjectCard.astro site/src/pages/projects.astro
git commit -m "Restyle ProjectCard and Projects page"
```

---

### Task 6: Restyle the Home page

**Files:**
- Modify: `site/src/pages/index.astro`

**Interfaces:**
- Consumes: Task 1 tokens only (`text-clay`, `text-ink-muted`, `border-line`).
- Produces: nothing new consumed elsewhere.

- [x] **Step 1: Replace index.astro**

Replace the full contents of `site/src/pages/index.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home" description="Zack Miller — engineer at Torc Robotics, Virginia Tech alum.">
  <section class="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
    <img src="/images/headshot.jpg" alt="Zack Miller" width="240" class="rounded-lg border border-line" />
    <div>
      <h1 class="text-3xl font-semibold">Zack Miller</h1>
      <p class="mt-2 text-ink-muted">
        I'm an engineer with a B.S. and M.S. in Engineering Mechanics from
        Virginia Tech, currently working at Torc Robotics in Blacksburg, VA.
        See <a href="/projects" class="text-clay hover:opacity-75">Projects</a> for a sample of my work.
      </p>
    </div>
  </section>
  <section class="mt-12">
    <h2 class="text-xl font-semibold">Timeline</h2>
    <ul class="mt-4 space-y-3 border-l border-line pl-4">
      <li><span class="font-semibold text-clay">2018–present</span> — Torc Robotics, Blacksburg, VA</li>
      <li><span class="font-semibold text-clay">2018</span> — M.S., Engineering Mechanics, Virginia Tech</li>
      <li><span class="font-semibold text-clay">2017</span> — B.S., Engineering Mechanics, Virginia Tech</li>
    </ul>
  </section>
</BaseLayout>
```

- [x] **Step 2: Verify**

Run `astro dev --background`, open `/`: headshot + name + intro should sit side by
side on desktop and stack on mobile width (~400px); timeline entries should show
clay-colored year markers against a left hairline border. Run `astro dev stop`.

- [x] **Step 3: Commit**

```bash
git add site/src/pages/index.astro
git commit -m "Restyle Home page"
```

---

### Task 7: Restyle the Resume page

**Files:**
- Modify: `site/src/pages/resume.astro`

**Interfaces:**
- Consumes: Task 1 tokens only (`text-clay`, `text-ink-muted`).
- Produces: nothing new consumed elsewhere.

- [x] **Step 1: Replace resume.astro**

Replace the full contents of `site/src/pages/resume.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Resume" description="Zack Miller's resume.">
  <h1 class="text-2xl font-semibold">Resume</h1>
  <p class="mt-2">
    <a href="/resume.pdf" class="text-clay hover:opacity-75">Download PDF</a>
  </p>
  <section class="mt-8">
    <h2 class="text-lg font-semibold">Education</h2>
    <ul class="mt-2 space-y-1 text-ink-muted">
      <li>M.S., Engineering Mechanics — Virginia Tech, 2018</li>
      <li>B.S., Engineering Mechanics — Virginia Tech, 2017</li>
    </ul>
  </section>
  <section class="mt-8">
    <h2 class="text-lg font-semibold">Experience</h2>
    <ul class="mt-2 space-y-1 text-ink-muted">
      <li>Torc Robotics — Blacksburg, VA (2018–present)</li>
    </ul>
  </section>
</BaseLayout>
```

- [x] **Step 2: Verify**

Run `astro dev --background`, open `/resume`: heading hierarchy and spacing should
match the rest of the site; download link is clay-colored. Run `astro dev stop`.

- [x] **Step 3: Commit**

```bash
git add site/src/pages/resume.astro
git commit -m "Restyle Resume page"
```

---

### Task 8: Extract PhotoCard and restyle the Compendium page

**Files:**
- Create: `site/src/components/PhotoCard.astro`
- Modify: `site/src/pages/compendium.astro`
- Test: `site/tests/compendium-client.test.ts` (existing — not modified, re-run to confirm it still passes)

**Interfaces:**
- Consumes: `CollectionEntry<'photos'>` (existing schema, unchanged: `file`, `datetime`,
  `tier: 'S'|'A'|'B'|'C'|'D'|'E'|'F'`, `notes`, `objects`, `slug`); `sortPhotos` /
  `PhotoSummary` from `site/src/lib/photo-sort.ts` (existing, unchanged); the existing
  `compendium-client.ts` DOM contract, which **must be preserved exactly**: an element
  with `id="photo-grid"` containing direct children carrying `data-slug="<slug>"`, an
  element `id="sort-select"`, and a `<script type="application/json" id="photo-data">`.
  Task 1 tokens: `border-line`, `bg-paper`, `text-ink-muted`, `bg-line`, `bg-tier-s`…`bg-tier-f`.
- Produces: `PhotoCard` component with `Props = { photo: CollectionEntry<'photos'>; r2Base: string }`.

- [x] **Step 1: Create PhotoCard.astro**

Create `site/src/components/PhotoCard.astro`:

```astro
---
import type { CollectionEntry } from 'astro:content';

interface Props {
  photo: CollectionEntry<'photos'>;
  r2Base: string;
}

const { photo, r2Base } = Astro.props;
const { file, datetime, tier, notes, objects, slug } = photo.data;

const tierDotClass: Record<string, string> = {
  S: 'bg-tier-s',
  A: 'bg-tier-a',
  B: 'bg-tier-b',
  C: 'bg-tier-c',
  D: 'bg-tier-d',
  E: 'bg-tier-e',
  F: 'bg-tier-f',
};
---
<li class="rounded-lg border border-line bg-paper p-3 shadow-sm" data-slug={slug}>
  <img
    src={`${r2Base}/${file}-thumb.jpg`}
    alt={notes ?? slug}
    loading="lazy"
    class="w-full rounded-md object-cover"
  />
  <p class="mt-2 flex items-center justify-between text-xs text-ink-muted">
    <span>{datetime.toISOString().slice(0, 10)}</span>
    <span class="flex items-center gap-1.5">
      <span class={`h-2 w-2 rounded-full ${tierDotClass[tier]}`}></span>
      Tier {tier}
    </span>
  </p>
  <ul class="mt-2 flex flex-wrap gap-1">
    {objects.map((obj) => (
      <li class="rounded-full bg-line/50 px-2 py-0.5 text-xs text-ink-muted">
        {obj.object_type === 'organism' ? obj.details.common_name : obj.details.description}
      </li>
    ))}
  </ul>
</li>
```

- [x] **Step 2: Update compendium.astro to use PhotoCard**

Replace the full contents of `site/src/pages/compendium.astro`:

```astro
---
import { getCollection } from 'astro:content';
import BaseLayout from '../layouts/BaseLayout.astro';
import PhotoCard from '../components/PhotoCard.astro';
import { sortPhotos, type PhotoSummary } from '../lib/photo-sort';

const allPhotos = await getCollection('photos');
const r2Base = import.meta.env.PUBLIC_R2_BASE_URL ?? '';
if (!r2Base) {
  console.warn('PUBLIC_R2_BASE_URL is not set — photo images will 404.');
}

const summaries: PhotoSummary[] = allPhotos.map((p) => ({
  date: p.data.datetime.toISOString().slice(0, 10),
  slug: p.data.slug,
  tier: p.data.tier,
}));

const orderedSlugs = sortPhotos(summaries, 'date').map((p) => p.slug);
const photosBySlug = new Map(allPhotos.map((p) => [p.data.slug, p]));
const orderedPhotos = orderedSlugs.map((slug) => photosBySlug.get(slug)!);
---
<BaseLayout title="Compendium" description="A browsable compendium of photography by Zack Miller.">
  <h1 class="text-2xl font-semibold">Compendium</h1>
  <div class="mt-4 text-sm text-ink-muted">
    <label class="flex items-center gap-2">
      Sort by
      <select id="sort-select" class="rounded border border-line bg-paper px-2 py-1 text-ink">
        <option value="date">Date</option>
        <option value="tier">Tier</option>
      </select>
    </label>
  </div>
  <ul id="photo-grid" class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
    {orderedPhotos.map((photo) => (
      <PhotoCard photo={photo} r2Base={r2Base} />
    ))}
  </ul>
  <script type="application/json" id="photo-data" set:html={JSON.stringify(summaries)} />
  <script src="../scripts/compendium-client.ts"></script>
</BaseLayout>
```

- [x] **Step 3: Run the existing client-sort test to confirm the DOM contract held**

Run:
```bash
cd site && npm test -- compendium-client
```
Expected: all 4 existing tests in `compendium-client.test.ts` still pass — they only
depend on `#photo-grid`/`[data-slug]`/`#sort-select`/`#photo-data`, none of which
changed.

- [x] **Step 4: Manually verify the grid**

Run `astro dev --background`, open `/compendium`: photos render as bordered cards
in a responsive grid (2 columns on mobile, up to 4 on desktop), each with a small
colored dot next to "Tier X" (darker/greener dot for S, fading toward gray for F).
Switch the sort dropdown to "Tier" and confirm the grid reorders. Run `astro dev stop`.

- [x] **Step 5: Commit**

```bash
git add site/src/components/PhotoCard.astro site/src/pages/compendium.astro
git commit -m "Extract PhotoCard component and restyle Compendium page"
```

---

### Task 9: Full-site verification pass

**Files:** none (verification only; fixes go in whichever file needs them).

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: final verified state of the branch.

- [x] **Step 1: Run the full existing test suite**

```bash
cd site && npm test
```
Expected: all existing suites pass unchanged (`photo-sort`, `compendium-client`,
`content-schema`, `content-config`, `social-links`, `cli`, `exif`, `publish`, `r2`,
`resize`).

- [x] **Step 2: Run a full production build**

```bash
cd site && npm run build
```
Expected: succeeds with no errors or warnings about the Tailwind plugin.

- [x] **Step 3: Manual cross-page check**

Run `astro dev --background`. For each of `/`, `/projects`, `/resume`, `/compendium`:
check in both light and dark mode (toggle via the header button) and at ~400px width
(mobile) that: text is legible against its background, no horizontal scrollbar
appears, and the clay accent is the only color used for links/active states outside
the photo-tier dots. Run `astro dev stop`.

- [x] **Step 4: Fix or commit**

If Step 3 surfaces any issue, fix it in the relevant file from Tasks 1–8 and commit
with a message describing the fix (e.g. `git commit -m "Fix mobile overflow on Home hero"`).
If nothing is found, no commit is needed for this task — the branch is done.

---

## Self-Review Notes

- **Spec coverage:** every spec section maps to a task — token architecture (Task 1),
  dark mode (Task 2/3), type scale (Task 1), Header/Footer/BaseLayout/ProjectCard/
  index/resume (Tasks 2–7), PhotoCard extraction (Task 8), photo-tier ordinal ramp
  (Tasks 1 & 8), testing approach (Task 9, matches spec's "manual verification, no
  new test infra"). Cross-repo distribution mechanism is out of scope per spec — no
  task needed.
- **Placeholder scan:** no TBD/TODO; every step has literal file contents or an exact
  runnable command.
- **Type consistency:** `PhotoCard` Props (`photo: CollectionEntry<'photos'>`,
  `r2Base: string`) match how Task 8 Step 2 calls it (`<PhotoCard photo={photo}
  r2Base={r2Base} />`). The `tierDotClass`/`linkClass` naming is used consistently
  within its own task and isn't referenced elsewhere in a way that could drift.
