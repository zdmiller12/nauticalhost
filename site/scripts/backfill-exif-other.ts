import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { extractExif } from './lib/exif';
import { backfillExifOther } from './lib/backfill-exif-other';

/* v8 ignore start -- CLI bootstrap; only runs when this file is executed directly */
async function main(): Promise<void> {
  const [sourcePath, yamlPath] = process.argv.slice(2);
  if (!sourcePath || !yamlPath) {
    console.error('Usage: npm run backfill-exif-other -- <sourcePath> <yamlPath>');
    process.exit(1);
    return;
  }

  const result = await backfillExifOther(
    {
      extractExif,
      readSourceFile: readFile,
      readYamlFile: (path) => readFile(path, 'utf-8'),
      writeYamlFile: writeFile,
    },
    { sourcePath, yamlPath }
  );

  console.log(result.skipped ? `Skipped ${yamlPath}: already has an 'other' field.` : `Backfilled 'other' into ${yamlPath}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
/* v8 ignore stop */
