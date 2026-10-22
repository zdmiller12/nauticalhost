import 'dotenv/config';
import { glob } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { syncInaturalist } from './lib/sync-inaturalist';

/* v8 ignore start -- CLI bootstrap; only runs when this file is executed directly */
if (import.meta.url === `file://${process.argv[1]}`) {
  const appId = process.env.INATURALIST_APP_ID;
  const appSecret = process.env.INATURALIST_APP_SECRET;
  const password = process.env.INATURALIST_PASSWORD;
  const username = process.env.INATURALIST_USERNAME;

  if (!appId || !appSecret || !password || !username) {
    console.error('Missing iNaturalist env vars. Copy site/.env.example to site/.env and fill it in.');
    process.exit(1);
  }

  const credentials = { appId: appId!, appSecret: appSecret!, password: password!, username: username! };

  syncInaturalist(
    {
      fetch,
      glob: async (pattern) => {
        const matches: string[] = [];
        for await (const entry of glob(pattern)) matches.push(entry);
        return matches;
      },
      readFile: (path) => readFile(path, 'utf-8'),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      writeFile: (path, contents) => writeFile(path, contents, 'utf-8'),
    },
    credentials,
    'src/content/photos/*.yaml'
  )
    .then((result) => {
      console.log(`Synced. ${result.changedFiles.length} file(s) changed: ${result.changedFiles.join(', ')}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
/* v8 ignore stop */
