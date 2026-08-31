# Personal Site (v1) — Design

Date: 2026-08-31

## Purpose

A recruiter/professional-contact-facing personal site: who I am, what I've built,
and how to reach me. First sub-project in the `nauticalhost` polylithic monorepo.
Other sub-projects (hosted tools like Word API, photo/data hosting) are separate,
later specs — this document covers the site only.

## Context

- Domain purchased on Cloudflare; DNS lives there already.
- Repo is "polylithic": one repo, multiple independently deployable projects,
  minimal shared tooling between them.
- No existing site or code — this is a from-scratch build.

## Architecture

Astro static site, deployed via Cloudflare Pages, connected directly to the
GitHub repo for auto-deploy on push to `main`. Astro was chosen over Next.js and
plain HTML because this site is content-first (bio, project descriptions, resume)
with only occasional interactive "islands" needed later — Astro ships zero JS by
default and only hydrates components that ask for it, and it has first-class
Cloudflare Pages support with no adapter friction.

The monorepo stays polylithic: each top-level folder is an independently
deployable project. Only `site/` is built in this spec; `tools/` and `photos/`
are placeholders for future, separately-designed sub-projects.

## Repo layout

```
nauticalhost/
├── site/                  # Astro personal site (this spec)
│   ├── src/
│   │   ├── pages/         # index.astro, projects.astro, resume.astro
│   │   ├── components/    # Header, Footer, ProjectCard, etc.
│   │   ├── layouts/       # BaseLayout.astro
│   │   └── content/       # content collection for projects (markdown/YAML)
│   ├── public/            # static assets: resume.pdf, favicon, images
│   ├── astro.config.mjs
│   └── package.json
├── tools/                 # future: word-api and other tools, each own subfolder (not built yet)
├── photos/                # future: photo/data hosting (not built yet)
└── README.md
```

Cloudflare Pages is configured with **root directory = `site/`**, so it only
watches/builds that folder. This is what lets a future `tools/word-api` become
its own separate Cloudflare Pages/Workers project in the same repo without its
build or deploy interfering with the site's.

## Site structure

- `/` — About/Home: bio, headshot, short pitch, links to Projects/Resume/contact.
- `/projects` — cards rendered from an Astro content collection (title,
  description, link, tags). Adding a project later means adding one
  markdown/YAML file to `src/content/projects/` — no code change.
- `/resume` — on-page resume content plus a downloadable PDF (`public/resume.pdf`).
- Footer with contact links (email, LinkedIn, GitHub) present on every page.

## Data flow

Fully static: Astro builds every page at build time from the content-collection
files checked into the repo. No runtime API calls, no client-side data fetching,
minimal client-side JS (e.g. a mobile nav toggle, if needed).

Out of scope for this spec: a future tool demo (e.g. Word API) would be added as
an Astro island component that calls out to that tool's separately-hosted
Worker. That integration is deferred to the tool-hosting sub-project's own spec.

## Deployment

Cloudflare Pages connects directly to the GitHub repo (once pushed) and
auto-deploys `site/` on every push to `main`. No GitHub Actions needed for this
piece. The custom domain (already on Cloudflare DNS) is pointed at the Pages
project via the Cloudflare dashboard.

## Error handling

Static content site — the main failure modes are build-time, not runtime:

- A malformed content-collection entry (e.g. missing required frontmatter
  field) fails `astro build`, which fails the Cloudflare Pages deploy before it
  goes live. Astro's content collection schema (Zod) is the guard here.
- Broken internal links are not automatically caught by the build; a manual
  click-through before/after each deploy is the mitigation for v1 (no link
  checker — out of scope until the site grows).

## Testing

- `astro build` succeeding is the primary check — it validates content
  collection schemas and catches build-breaking errors.
- Manual browser pass after each deploy: navigation, responsive layout at a
  couple of breakpoints, resume PDF link, contact links.
- No automated unit/component test suite for v1 — there's no business logic to
  test yet. If interactive tool islands are added later, add component tests
  at that point.

## Explicitly out of scope for this spec

- `tools/` (Word API and other hosted tools) — separate design/spec later.
- `photos/` (photo/data hosting) — separate design/spec later.
- Blog/writing section — deferred; can be added later via an additional Astro
  content collection without restructuring the site.
- Contact form — static contact links (email/LinkedIn/GitHub) only, to avoid
  needing a backend and spam handling for v1.
