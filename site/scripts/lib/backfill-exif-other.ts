import type { PhotoExif } from './exif';
import { formatOtherYaml } from './publish';

export interface BackfillDeps {
  extractExif: (buffer: Buffer) => Promise<PhotoExif>;
  readSourceFile: (path: string) => Promise<Buffer>;
  readYamlFile: (path: string) => Promise<string>;
  writeYamlFile: (path: string, contents: string) => Promise<void>;
}

export interface BackfillArgs {
  sourcePath: string;
  yamlPath: string;
}

export interface BackfillResult {
  skipped: boolean;
}

/**
 * Appends an `other:` EXIF catch-all block to an already-published photo's
 * YAML file, re-deriving it from the original source image rather than the
 * YAML (which never had it). Leaves every hand-authored field (tier,
 * objects, notes, ...) untouched by appending rather than reserializing the
 * whole file, so existing formatting/comments survive exactly as written.
 */
export async function backfillExifOther(deps: BackfillDeps, args: BackfillArgs): Promise<BackfillResult> {
  const existing = await deps.readYamlFile(args.yamlPath);
  if (/^other:/m.test(existing)) {
    return { skipped: true };
  }

  const source = await deps.readSourceFile(args.sourcePath);
  const exif = await deps.extractExif(source);
  const otherBlock = formatOtherYaml(exif.other);

  const updated = `${existing.replace(/\n+$/, '')}\n${otherBlock}\n`;
  await deps.writeYamlFile(args.yamlPath, updated);
  return { skipped: false };
}
