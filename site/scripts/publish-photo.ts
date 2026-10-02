import 'dotenv/config';
import { createRealCliIo, runCli } from './lib/cli';

/* v8 ignore start -- CLI bootstrap; only runs when this file is executed directly */
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(createRealCliIo()).catch((err) => {
    console.error(err);
    console.error('Usage:   npm run publish-photo -- <localPath> <r2KeyPrefix>');
    console.error('Example: npm run publish-photo -- ~/mnt/nas-photos/photo.JPG compendium/alpha');
    process.exit(1);
  });
}
/* v8 ignore stop */
