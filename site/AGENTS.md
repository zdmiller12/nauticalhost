## Project conventions

- **Tests gate at 100%.** `npm test` enforces a per-file 100% threshold
  (statements/branches/functions/lines) over `scripts/` and `src/` — one
  undertested file fails the whole run. New code needs tests in the same change.
  Use a narrow `/* v8 ignore */` only for lines that would require really
  exiting the process or exec'ing a real CLI.
- **Object and schema fields are ordered alphabetically** (see
  `src/content/schema.ts`, `src/lib/balance-accounts.ts`). Keep new fields in
  alphabetical position rather than appending them.
- **Money is integer minor units.** Never hold a currency amount in a float;
  see `src/lib/balance-accounts.ts`.
- **Widgets are registry-driven.** A widget is an entry in `WIDGETS` plus a
  `WidgetPanel` block plus client wiring; `WidgetPanel.astro` throws at build
  time on an unregistered id.
- **The résumé has no committed PDF.** `/professional` renders the `experience`
  collection and generates the PDF client-side; edit content files, not a binary.

Orientation for the whole site — layout, commands, publishing flows, and the
current list of known gaps — is in `USER_GUIDE.md`, with longer-form detail in
`README.md`.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
