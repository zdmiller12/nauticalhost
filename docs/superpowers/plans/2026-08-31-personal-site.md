# Personal Site (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy v1 of the personal/portfolio site — About/Home, Projects, and Resume pages — as an Astro static site ready for Cloudflare Pages.

**Architecture:** Astro static site (Content Layer API for the projects collection) living in `site/` at the repo root. Fully static output — no server runtime, no client-side data fetching. Content (project entries, social links) lives in typed data/content files so adding a project later means adding one file, not touching page code.

**Tech Stack:** Astro (latest), TypeScript (strict), Zod (via `astro:content`'s Content Layer API, plus a standalone `zod` dependency for unit-testable schemas), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-personal-site-design.md`

## Global Constraints

- Fully static output — no runtime server logic, no client-side API calls (spec: Data flow).
- Deploy target is Cloudflare Pages with **root directory `site/`** — nothing outside `site/` is part of this build (spec: Repo layout, Deployment).
- No contact form — footer has static links only: GitHub, LinkedIn, email (spec: Explicitly out of scope).
- No blog/writing section in v1 (spec: Explicitly out of scope).
- Testing philosophy: `astro build` succeeding is the primary gate; real unit tests are written only where there's actual logic (the projects content schema); markup-only pages/components are verified by asserting expected strings appear in the built HTML (spec: Testing, made concrete per-task below).
- Reused facts/assets from the previous site (`/home/miller/git/zdmiller12.github.io`): headshot photo, Virginia Tech BS/MS + Torc Robotics timeline, GitHub/LinkedIn/email links, favicon set (spec: Content migration).
- Projects to migrate: **OSM Scene** and **Word API** only. *Good Robot* is dropped — its GitHub repo 404s as of 2026-08-31 (spec: Content migration).
- `public/resume.pdf` is not created by this plan — it's supplied by the user afterward. Tasks build the resume page to link to it regardless.

---

### Task 1: Scaffold Astro project + base layout shell

**Files:**
- Create: `site/` (via `npm create astro@latest`)
- Create: `site/src/layouts/BaseLayout.astro`
- Create: `site/src/components/Header.astro`
- Create: `site/src/components/Footer.astro`
- Modify: `site/src/pages/index.astro`

**Interfaces:**
- Produces: `BaseLayout.astro` accepts `Props { title: string; description?: string }` and renders `<slot />` between `<Header />` and `<Footer />`. Later tasks import it as `import BaseLayout from '../layouts/BaseLayout.astro'` and use `<BaseLayout title="..." description="...">...</BaseLayout>`.

- [ ] **Step 1: Scaffold the Astro project**

Run from the repo root (`nauticalhost/`):

```bash
npm create astro@latest site -- --yes --template minimal --typescript strict --install --no-git
```

This creates `site/` with a minimal Astro project, TypeScript strict config, and dependencies installed. Do not run `astro add` integrations — none are needed for a static content site.

- [ ] **Step 2: Verify the scaffold builds**

```bash
cd site && npm run build
```

Expected: `dist/` is created, build exits 0, no errors.

- [ ] **Step 3: Copy the favicon from the previous site**

```bash
cp /home/miller/git/zdmiller12.github.io/assets/img/icon/favicon-32x32.png site/public/favicon.png
```

- [ ] **Step 4: Write the base layout**

`site/src/layouts/BaseLayout.astro`:

```astro
---
import Header from '../components/Header.astro';
import Footer from '../components/Footer.astro';

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
  </head>
  <body>
    <Header />
    <main>
      <slot />
    </main>
    <Footer />
  </body>
</html>
```

- [ ] **Step 5: Write the header (nav)**

`site/src/components/Header.astro`:

```astro
<header>
  <nav>
    <a href="/">Home</a>
    <a href="/projects">Projects</a>
    <a href="/resume">Resume</a>
  </nav>
</header>
```

- [ ] **Step 6: Write a placeholder footer**

`site/src/components/Footer.astro` (social links are wired in Task 2 — this is just the shell so the build succeeds):

```astro
<footer>
  <p>&copy; {new Date().getFullYear()} Zack Miller</p>
</footer>
```

- [ ] **Step 7: Wire the home page to use the layout**

Replace the contents of `site/src/pages/index.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home">
  <h1>Zack Miller</h1>
</BaseLayout>
```

- [ ] **Step 8: Build and verify the shell renders**

```bash
npm run build
grep -q '>Projects<' dist/index.html && grep -q '>Resume<' dist/index.html && grep -q '>Zack Miller<' dist/index.html && grep -q 'href="/favicon.png"' dist/index.html && echo PASS
```

Expected: `PASS` printed, no grep failures.

- [ ] **Step 9: Commit**

```bash
git add site/
git commit -m "Scaffold Astro site with base layout, header, and footer shell"
```

---

### Task 2: Social links data module + wire the footer

**Files:**
- Create: `site/src/data/social-links.ts`
- Modify: `site/src/components/Footer.astro`

**Interfaces:**
- Consumes: nothing new.
- Produces: `socialLinks: SocialLink[]` where `interface SocialLink { label: string; url: string }`, exported from `site/src/data/social-links.ts`. Any future page needing contact links imports `{ socialLinks }` from this module — this is the single source of truth, don't hardcode links elsewhere.

- [ ] **Step 1: Write the social links data module**

`site/src/data/social-links.ts`:

```ts
export interface SocialLink {
  label: string;
  url: string;
}

export const socialLinks: SocialLink[] = [
  { label: 'GitHub', url: 'https://github.com/zdmiller12' },
  { label: 'LinkedIn', url: 'https://linkedin.com/in/zdmiller12' },
  { label: 'Email', url: 'mailto:zdmiller12@gmail.com' },
];
```

- [ ] **Step 2: Wire the footer to render these links**

Replace `site/src/components/Footer.astro`:

```astro
---
import { socialLinks } from '../data/social-links';
---
<footer>
  <nav>
    {socialLinks.map((link) => (
      <a href={link.url}>{link.label}</a>
    ))}
  </nav>
  <p>&copy; {new Date().getFullYear()} Zack Miller</p>
</footer>
```

- [ ] **Step 3: Build and verify the links render**

```bash
npm run build
grep -q 'href="https://github.com/zdmiller12"' dist/index.html && grep -q 'href="mailto:zdmiller12@gmail.com"' dist/index.html && echo PASS
```

Expected: `PASS` printed.

- [ ] **Step 4: Commit**

```bash
git add site/src/data/social-links.ts site/src/components/Footer.astro
git commit -m "Add social links data module and wire footer"
```

---

### Task 3: Projects content schema (TDD)

**Files:**
- Create: `site/src/content/schema.ts`
- Create: `site/src/content/config.ts`
- Create: `site/vitest.config.ts`
- Test: `site/tests/content-schema.test.ts`
- Modify: `site/package.json` (add `zod`, `vitest` deps and a `test` script)

**Interfaces:**
- Produces: `projectSchema` (a Zod object schema), exported from `site/src/content/schema.ts`, validating `{ title: string; description: string; githubUrl: string (url); demoUrl?: string (url); tags: string[]; order: number (default 0) }`. Task 4's content entries and `ProjectCard` component rely on exactly these field names and types.
- Produces: the `projects` collection registered in `astro:content` via `site/src/content/config.ts`, queryable elsewhere as `getCollection('projects')`.

- [ ] **Step 1: Add test dependencies**

```bash
cd site && npm install --save zod && npm install --save-dev vitest
```

Add to `site/package.json` `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write the failing test**

`site/tests/content-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectSchema } from '../src/content/schema';

describe('projectSchema', () => {
  it('accepts a valid project entry', () => {
    const result = projectSchema.safeParse({
      title: 'OSM Scene',
      description: 'Transforming OpenStreetMap data.',
      githubUrl: 'https://github.com/zdmiller12/osm-scene',
      tags: ['python', 'gis'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an entry missing a required title', () => {
    const result = projectSchema.safeParse({
      description: 'Missing a title.',
      githubUrl: 'https://github.com/zdmiller12/example',
      tags: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with an invalid githubUrl', () => {
    const result = projectSchema.safeParse({
      title: 'Bad URL',
      description: 'Has a non-URL githubUrl.',
      githubUrl: 'not-a-url',
      tags: [],
    });
    expect(result.success).toBe(false);
  });
});
```

`site/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `site/src/content/schema.ts` does not exist yet (module not found).

- [ ] **Step 4: Implement the schema**

`site/src/content/schema.ts`:

```ts
import { z } from 'zod';

export const projectSchema = z.object({
  title: z.string(),
  description: z.string(),
  githubUrl: z.string().url(),
  demoUrl: z.string().url().optional(),
  tags: z.array(z.string()),
  order: z.number().default(0),
});

export type Project = z.infer<typeof projectSchema>;
```

`site/src/content/config.ts`:

```ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { projectSchema } from './schema';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: projectSchema,
});

export const collections = { projects };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS — all 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add site/src/content/schema.ts site/src/content/config.ts site/vitest.config.ts site/tests/content-schema.test.ts site/package.json site/package-lock.json
git commit -m "Add projects content schema with unit tests"
```

---

### Task 4: Migrate project entries + Projects page

**Files:**
- Create: `site/src/content/projects/osm-scene.md`
- Create: `site/src/content/projects/word-api.md`
- Create: `site/src/components/ProjectCard.astro`
- Create: `site/src/pages/projects.astro`

**Interfaces:**
- Consumes: `projectSchema` fields from Task 3 (`title`, `description`, `githubUrl`, `demoUrl`, `tags`, `order`); `BaseLayout` from Task 1.
- Produces: `ProjectCard.astro` accepts `Props { project: CollectionEntry<'projects'> }`.

- [ ] **Step 1: Add the OSM Scene entry**

`site/src/content/projects/osm-scene.md`:

```markdown
---
title: "OSM Scene"
description: "Transforming OpenStreetMap data."
githubUrl: "https://github.com/zdmiller12/osm-scene"
tags: ["python", "gis"]
order: 1
---
```

- [ ] **Step 2: Add the Word API entry**

`site/src/content/projects/word-api.md`:

```markdown
---
title: "Word API"
description: "Crossword data garden and API."
githubUrl: "https://github.com/zdmiller12/word-api"
tags: ["api"]
order: 2
---
```

- [ ] **Step 3: Write the project card component**

`site/src/components/ProjectCard.astro`:

```astro
---
import type { CollectionEntry } from 'astro:content';

interface Props {
  project: CollectionEntry<'projects'>;
}

const { project } = Astro.props;
const { title, description, githubUrl, demoUrl, tags } = project.data;
---
<article class="project-card">
  <h2>{title}</h2>
  <p>{description}</p>
  <ul class="tags">
    {tags.map((tag) => <li>{tag}</li>)}
  </ul>
  <div class="links">
    <a href={githubUrl}>GitHub</a>
    {demoUrl && <a href={demoUrl}>Live demo</a>}
  </div>
</article>
```

- [ ] **Step 4: Write the projects page**

`site/src/pages/projects.astro`:

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
  <h1>Projects</h1>
  {projects.map((project) => <ProjectCard project={project} />)}
</BaseLayout>
```

- [ ] **Step 5: Build and verify both projects render**

```bash
npm run build
grep -q 'OSM Scene' dist/projects/index.html && grep -q 'Word API' dist/projects/index.html && grep -q 'href="https://github.com/zdmiller12/osm-scene"' dist/projects/index.html && grep -q 'href="https://github.com/zdmiller12/word-api"' dist/projects/index.html && echo PASS
```

Expected: `PASS` printed.

- [ ] **Step 6: Commit**

```bash
git add site/src/content/projects/ site/src/components/ProjectCard.astro site/src/pages/projects.astro
git commit -m "Add OSM Scene and Word API project entries and Projects page"
```

---

### Task 5: About/Home page content

**Files:**
- Create: `site/public/images/headshot.jpg` (copied asset)
- Modify: `site/src/pages/index.astro`

**Interfaces:**
- Consumes: `BaseLayout` from Task 1.
- No new exports for other tasks to depend on.

- [ ] **Step 1: Copy the headshot asset from the previous site**

```bash
mkdir -p site/public/images
cp /home/miller/git/zdmiller12.github.io/assets/img/2018_grad-composite.jpeg site/public/images/headshot.jpg
```

- [ ] **Step 2: Write the About/Home content**

Replace `site/src/pages/index.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home" description="Zack Miller — engineer at Torc Robotics, Virginia Tech alum.">
  <section class="hero">
    <img src="/images/headshot.jpg" alt="Zack Miller" width="240" />
    <h1>Zack Miller</h1>
    <p>
      I'm an engineer with a B.S. and M.S. in Engineering Mechanics from
      Virginia Tech, currently working at Torc Robotics in Blacksburg, VA.
      Outside of work I build small tools and side projects — see
      <a href="/projects">Projects</a> for a few of them.
    </p>
  </section>
  <section class="timeline">
    <h2>Timeline</h2>
    <ul>
      <li><strong>2018–present</strong> — Torc Robotics, Blacksburg, VA</li>
      <li><strong>2018</strong> — M.S., Engineering Mechanics, Virginia Tech</li>
      <li><strong>2017</strong> — B.S., Engineering Mechanics, Virginia Tech</li>
    </ul>
  </section>
</BaseLayout>
```

> Note for the human reviewer: the bio paragraph above uses only verified
> facts (degrees, employer). It intentionally does not invent hobbies,
> location, or a "current focus" sentence — that's real personal framing
> only you can write accurately, and is worth a deliberate pass rather than
> guessed filler.

- [ ] **Step 3: Build and verify the content renders**

```bash
npm run build
grep -q 'Torc Robotics' dist/index.html && grep -q 'Virginia Tech' dist/index.html && grep -q 'src="/images/headshot.jpg"' dist/index.html && echo PASS
```

Expected: `PASS` printed.

- [ ] **Step 4: Commit**

```bash
git add site/public/images/headshot.jpg site/src/pages/index.astro
git commit -m "Add About/Home page content with bio and timeline"
```

---

### Task 6: Resume page

**Files:**
- Create: `site/src/pages/resume.astro`

**Interfaces:**
- Consumes: `BaseLayout` from Task 1.
- No new exports for other tasks to depend on.

- [ ] **Step 1: Write the resume page**

`site/src/pages/resume.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Resume" description="Zack Miller's resume.">
  <h1>Resume</h1>
  <p><a href="/resume.pdf">Download PDF</a></p>
  <section>
    <h2>Education</h2>
    <ul>
      <li>M.S., Engineering Mechanics — Virginia Tech, 2018</li>
      <li>B.S., Engineering Mechanics — Virginia Tech, 2017</li>
    </ul>
  </section>
  <section>
    <h2>Experience</h2>
    <ul>
      <li>Torc Robotics — Blacksburg, VA (2018–present)</li>
    </ul>
  </section>
</BaseLayout>
```

> The `/resume.pdf` link will 404 until an actual resume PDF is placed at
> `site/public/resume.pdf`. That file is supplied by the user, not generated
> by this plan (see Global Constraints).

- [ ] **Step 2: Build and verify the content renders**

```bash
npm run build
grep -q 'Download PDF' dist/resume/index.html && grep -q 'Virginia Tech' dist/resume/index.html && grep -q 'Torc Robotics' dist/resume/index.html && echo PASS
```

Expected: `PASS` printed.

- [ ] **Step 3: Commit**

```bash
git add site/src/pages/resume.astro
git commit -m "Add Resume page"
```

---

### Task 7: Cloudflare Pages deployment docs

**Files:**
- Create: `site/README.md`

**Interfaces:** None — documentation only, no code dependencies.

- [ ] **Step 1: Write the site README**

`site/README.md`:

```markdown
# Personal site

Astro static site for zdmiller12's personal/portfolio page.

## Local development

    npm install
    npm run dev

## Build

    npm run build      # outputs to dist/
    npm run preview    # preview the production build locally

## Tests

    npm test

## Deployment (Cloudflare Pages)

This site deploys via Cloudflare Pages' direct GitHub integration — no
GitHub Actions needed.

1. In the Cloudflare dashboard, create a new Pages project connected to this
   GitHub repo.
2. Set **Root directory** to `site`.
3. Set **Build command** to `npm run build`.
4. Set **Build output directory** to `dist`.
5. Deploy. Cloudflare auto-deploys on every push to `main`.
6. Point the custom domain (already on Cloudflare DNS) at the Pages project
   from the Pages project's "Custom domains" tab.
```

- [ ] **Step 2: Commit**

```bash
git add site/README.md
git commit -m "Add site README with local dev and Cloudflare Pages deployment instructions"
```

---

## After this plan

Not covered by this plan, needed before the site is fully "done":
- Supply `site/public/resume.pdf` (an actual resume document).
- Review/expand the About page bio (hobbies, location, "what I'm focused on now" — deliberately left factual-only above).
- Push the repo to GitHub and connect it in the Cloudflare Pages dashboard (Task 7's README documents the steps, but the dashboard connection itself needs the user's Cloudflare account).
- Point the Cloudflare-registered domain at the Pages project.
