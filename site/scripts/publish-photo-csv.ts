import 'dotenv/config';
import { createRealCsvIo, runPublishCsv } from './lib/publish-csv';

/* v8 ignore start -- CLI bootstrap; only runs when this file is executed directly */
if (import.meta.url === `file://${process.argv[1]}`) {
  runPublishCsv(createRealCsvIo()).catch((err) => {
    console.error(err);
    console.error('Usage:   npm run publish-photo-csv -- <csvPath>');
    console.error('Example: npm run publish-photo-csv -- photos.csv');
    process.exit(1);
  });
}
/* v8 ignore stop */
