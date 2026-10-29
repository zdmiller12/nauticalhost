import { createServer as createHttpServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import sharp from 'sharp';
import { LIGHTBOX_WIDTH } from './resize';
import { validatePosted, type AcceptedPhoto, type QueuePhoto } from './dialog-session';

/** How long an abandoned tab may hold the CLI open, measured from the last request (inactivity). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const CLIENT_PATH = 'scripts/lib/dialog-client.ts';

export interface ServerHandle {
  close: () => void;
  port: number;
}

export interface DialogRequest {
  body: string;
  method: string;
  url: string;
}

export interface DialogResponse {
  body: Buffer | string;
  contentType: string;
  status: number;
}

export interface DialogIo {
  /** The dialog client's TypeScript source. */
  clientSource: () => Promise<string>;
  /** Binds the router to an ephemeral port. */
  createServer: (handle: (request: DialogRequest) => Promise<DialogResponse>) => Promise<ServerHandle>;
  log: (msg: string) => void;
  /** Best-effort browser launch; the URL is always printed too. */
  openUrl: (url: string) => void;
  /** A 1600px JPEG preview of the source photo -- never the 24MP original. */
  renderPreview: (sourcePath: string) => Promise<Buffer>;
  setTimer: (ms: number, fn: () => void) => { cancel: () => void };
  /** TypeScript -> browser JavaScript. Does not bundle, hence the client's purity rule. */
  transformClient: (source: string) => Promise<string>;
  /** Resolves the session when the user interrupts the CLI. */
  watchInterrupt: (fn: () => void) => { cancel: () => void };
}

export interface DialogOptions {
  timeoutMs?: number;
}

export type DialogOutcome =
  | { kind: 'aborted' }
  | { kind: 'completed'; photos: AcceptedPhoto[] }
  | { kind: 'timeout' };

/**
 * The dialog page. The queue is embedded as JSON rather than fetched, so the
 * client has its work list before first paint, and the client is a real module
 * at its own URL because an inline `<script type="module">` cannot import from
 * itself (and `esbuild.transform` emits a module, not an IIFE).
 */
export function renderPage(queue: QueuePhoto[]): string {
  // Escape `</script` only: the payload sits in a JSON script block, where
  // that is the single sequence that can end the element early.
  const data = JSON.stringify(queue).replace(/<\/script/gi, '<\\/script');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Draw bounding boxes</title>
<style>
  /*
    One screenful, never a scrollbar: the controls and the photo split a
    100dvh flex column, each with a hard dvh cap so a photo-plus-ten-objects
    page cannot push the other half out of the window. The caps are plain
    lengths on purpose -- a percentage max-height inside the shrink-wrapped
    stage would resolve against an auto height and be ignored.
  */
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    background: #11151a; color: #e8edf2; font: 14px/1.4 system-ui, sans-serif;
    margin: 0; padding: .5rem; display: flex; flex-direction: column; gap: .5rem;
    height: 100dvh; overflow: hidden;
  }
  [data-dialog-controls] { flex: 0 0 auto; max-height: 24dvh; overflow-y: auto; display: flex; flex-direction: column; gap: .4rem; }
  [data-dialog-bar] { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
  [data-dialog-bar] input { width: 7rem; }
  [data-dialog-bar] [data-dialog-position] { opacity: .8; }
  /*
    The stage must shrink-wrap the photo exactly: the client normalizes every
    drawn box against the stage's rect, so any letterboxing inside it would
    offset the boxes. Hence a lone max-height on the replaced <img>, which
    keeps its aspect ratio, with the stage sized by it.
  */
  [data-dialog-canvas] { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  [data-dialog-stage] { position: relative; display: inline-block; max-width: 100%; cursor: crosshair; touch-action: none; }
  /* 74 + 24 + the padding and gap: a hair under one window, whatever the controls do. */
  [data-dialog-stage] img { display: block; width: auto; height: auto; max-width: 100%; max-height: 74dvh; }
  [data-dialog-overlay] { position: absolute; inset: 0; }
  [data-dialog-box] { position: absolute; border: 2px solid; box-sizing: border-box; cursor: move; }
  [data-dialog-box][data-active="true"] { outline: 3px solid #7fd1ff; background: rgba(127, 209, 255, .2); }
  /* Inside the box, not above it: the photo now sits at the window's bottom, so a label hung above a top-edge box would be clipped. */
  [data-dialog-box] span { position: absolute; top: 0; left: 0; font-size: 12px; padding: 0 .25rem; color: #11151a; }
  /* Centred on its corner (-5px is half its own size), so dragging it tracks the pointer under the cursor rather than under its top-left. */
  [data-dialog-handle] { position: absolute; width: 10px; height: 10px; background: #fff; border: 1px solid #11151a; border-radius: 50%; }
  [data-dialog-rows] { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
  [data-dialog-row] { display: flex; gap: .4rem; align-items: center; padding: .25rem .4rem; border-radius: .25rem; background: #1b222a; }
  [data-dialog-row][data-active="true"] { outline: 2px solid #7fd1ff; }
  [data-dialog-swatch] { width: 1rem; height: 1rem; border-radius: 2px; flex: none; }
  [data-dialog-existing] { list-style: none; margin: 0; padding: 0; opacity: .6; font-size: 12px; }
  [data-dialog-warnings]:empty { display: none; }
  [data-dialog-warnings] { background: #3a2c12; border-left: 3px solid #e0a63a; padding: .4rem .6rem; }
</style>
</head>
<body data-dialog>
<script type="application/json" data-dialog-queue>${data}</script>
<div data-dialog-controls>
  <div data-dialog-bar>
    <button data-dialog-action="prev" type="button">&larr; Previous</button>
    <span data-dialog-position></span>
    <button data-dialog-action="next" type="button">Next &rarr;</button>
    <label>Lat <input data-dialog-field="latitude" inputmode="decimal" /></label>
    <label>Lon <input data-dialog-field="longitude" inputmode="decimal" /></label>
    <button data-dialog-action="add" type="button">Add object without a box</button>
    <button data-dialog-action="submit" type="button">Publish</button>
    <button data-dialog-action="cancel" type="button">Cancel</button>
  </div>
  <ul data-dialog-rows></ul>
  <ul data-dialog-existing></ul>
  <div data-dialog-warnings role="status"></div>
</div>
<div data-dialog-canvas>
  <div data-dialog-stage><img data-dialog-image alt="" /><div data-dialog-overlay></div></div>
</div>
<template data-dialog-row-template>
  <li data-dialog-row>
    <span data-dialog-swatch></span>
    <select data-dialog-field="objectType">
      <option value="organism">Organism</option>
      <option value="landmark">Landmark</option>
    </select>
    <input data-dialog-field="scientificName" placeholder="Scientific name" />
    <input data-dialog-field="description" placeholder="Description" />
    <button data-dialog-action="up" type="button" title="Make primary">&uarr;</button>
    <button data-dialog-action="down" type="button">&darr;</button>
    <button data-dialog-action="delete" type="button">&times;</button>
  </li>
</template>
<!--
  The deps literal below is a template-literal string, so it must be kept in
  sync with \`DialogClientDeps\` in dialog-client.ts by hand: no test executes
  this bootstrap (the client tests supply their own deps), so renaming a member
  on either side breaks only the real browser. Change both together.
-->
<script type="module">
import { initDialog } from '/client.js';
initDialog(document.querySelector('[data-dialog]'), {
  rect: (element) => element.getBoundingClientRect(),
  send: (path, payload) =>
    fetch(path, { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, method: 'POST' }),
});
</script>
</body>
</html>
`;
}

const PHOTO_PATH = /^\/photo\/(\d+)$/;

/**
 * Routes one request. `resolve` ends the session; a response that does not
 * call it leaves the dialog open, which is what makes 400 and 409 recoverable
 * in the browser rather than fatal to the CLI run.
 */
export async function handleRequest(
  io: DialogIo,
  queue: QueuePhoto[],
  request: DialogRequest,
  resolve: (outcome: DialogOutcome) => void
): Promise<DialogResponse> {
  const json = (status: number, payload: unknown): DialogResponse => ({
    body: JSON.stringify(payload),
    contentType: 'application/json; charset=utf-8',
    status,
  });

  if (request.method === 'POST' && request.url === '/cancel') {
    resolve({ kind: 'aborted' });
    return json(200, { ok: true });
  }

  if (request.method === 'POST' && request.url === '/result') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return json(400, { errors: ['Posted body was not valid JSON.'] });
    }
    const outcome = validatePosted(parsed, queue);
    if ('errors' in outcome) return json(400, outcome);
    if ('duplicates' in outcome) return json(409, outcome);
    resolve({ kind: 'completed', photos: outcome.photos });
    return json(200, { ok: true });
  }

  if (request.url === '/') {
    return { body: renderPage(queue), contentType: 'text/html; charset=utf-8', status: 200 };
  }

  if (request.url === '/client.js') {
    return {
      body: await io.transformClient(await io.clientSource()),
      contentType: 'text/javascript; charset=utf-8',
      status: 200,
    };
  }

  const photoMatch = PHOTO_PATH.exec(request.url);
  if (photoMatch) {
    const photo = queue.find((entry) => entry.index === Number(photoMatch[1]));
    if (!photo) return json(404, { errors: ['No such photo in this session.'] });
    return { body: await io.renderPreview(photo.sourcePath), contentType: 'image/jpeg', status: 200 };
  }

  return json(404, { errors: ['Not found.'] });
}

/**
 * Runs one dialog session end to end and resolves exactly once.
 *
 * A one-shot server with no exit is a hung CLI, so there are three of them:
 * the user submitting or cancelling, an inactivity timeout, and an interrupt.
 * `finish` is idempotent because all three can race.
 */
export async function runDialog(
  io: DialogIo,
  queue: QueuePhoto[],
  options: DialogOptions = {}
): Promise<DialogOutcome> {
  let settle!: (outcome: DialogOutcome) => void;
  const settled = new Promise<DialogOutcome>((resolve) => {
    settle = resolve;
  });

  let done = false;
  const finish = (outcome: DialogOutcome) => {
    if (done) return;
    done = true;
    settle(outcome);
  };

  // A no-op initial handle means `touch()` needs no null check, and covers the
  // brief window between listen() and the first arming.
  let timer: { cancel: () => void } = { cancel: () => {} };
  const touch = () => {
    timer.cancel();
    timer = io.setTimer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => finish({ kind: 'timeout' }));
  };
  // The first arming and the interrupt watcher must stay AFTER the await: a
  // rejected `createServer` propagates before the try/finally below is
  // entered, which would leak a pending timer and a SIGINT handler.
  const server = await io.createServer(async (request) => {
    touch();
    return handleRequest(io, queue, request, finish);
  });
  touch();
  const interrupt = io.watchInterrupt(() => finish({ kind: 'aborted' }));

  const url = `http://localhost:${server.port}/`;
  io.log(`Draw bounding boxes at ${url} (${queue.length} photo(s))`);
  io.openUrl(url);

  try {
    return await settled;
  } finally {
    timer.cancel();
    interrupt.cancel();
    server.close();
  }
}

/* v8 ignore start -- real sockets, child processes and signal handlers */

/**
 * The desktop's configured browser, as a binary name: `xdg-settings` answers
 * with a desktop-entry id (`brave-browser.desktop`), and for every mainstream
 * browser that id is its executable. Snap-style ids (`firefox_firefox`) are
 * not, which costs nothing -- an unspawnable name just falls through to
 * `xdg-open` below.
 */
function defaultBrowserBinary(): string | null {
  try {
    const id = execFileSync('xdg-settings', ['get', 'default-web-browser'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return id.endsWith('.desktop') ? id.slice(0, -'.desktop'.length) : null;
  } catch {
    return null;
  }
}

/**
 * How to ask each platform for a *focused* window on the dialog.
 *
 * Every candidate is the user's own browser, never a guess: naming specific
 * browsers here once opened the dialog in a Firefox that was installed but
 * not wanted (and not working), while the real default sat unused. So the
 * only thing tried before plain `xdg-open` is that same default browser with
 * a `--new-window` on it -- which is the whole point, since `xdg-open` tends
 * to drop the URL into a background tab the user then has to hunt for.
 */
function browserCommands(url: string): Array<[string, string[]]> {
  if (process.platform === 'darwin') {
    // `open -n` makes a fresh instance, which macOS brings to the front.
    return [['open', ['-n', url]]];
  }
  if (process.platform === 'win32') {
    return [['cmd', ['/c', 'start', '', url]]];
  }
  const browser = process.env.BROWSER?.trim() || defaultBrowserBinary();
  return [
    ...(browser ? [[browser, ['--new-window', url]] as [string, string[]]] : []),
    ['xdg-open', [url]],
  ];
}

/** A browser that bails out slower than this was working, not failing. */
const LAUNCH_GRACE_MS = 5000;

/**
 * Walks the candidate commands until one takes the URL. "Takes it" cannot be
 * observed directly, so two kinds of failure hand off to the next candidate:
 * a binary that is not installed (an async 'error' event, never a throw) and
 * one that starts and immediately gives up -- a browser rejecting a flag, or
 * failing to reach a display. The grace window is what separates that from a
 * browser the user simply closes later, which must not reopen anything.
 */
function launchBrowser(url: string, candidates = browserCommands(url)): void {
  const [next, ...rest] = candidates;
  // Out of candidates: headless, or nothing installed. The URL was printed,
  // which is enough -- never fail a publish over a browser that won't open.
  if (!next) return;
  const startedAt = Date.now();
  const fallback = () => launchBrowser(url, rest);
  try {
    const child = spawn(next[0], next[1], { detached: true, stdio: 'ignore' });
    child.on('error', fallback);
    child.on('exit', (code) => {
      if (code !== 0 && Date.now() - startedAt < LAUNCH_GRACE_MS) fallback();
    });
    child.unref();
  } catch {
    fallback();
  }
}

/** Wires DialogIo to node:http, esbuild, sharp and the real clock. */
export function createRealDialogIo(): DialogIo {
  return {
    clientSource: () => readFile(CLIENT_PATH, 'utf-8'),
    createServer: (handle) =>
      new Promise((resolve) => {
        const server = createHttpServer((incoming, outgoing) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', async () => {
            const response = await handle({
              body: Buffer.concat(chunks).toString('utf-8'),
              method: incoming.method ?? 'GET',
              url: incoming.url ?? '/',
            });
            outgoing.writeHead(response.status, { 'content-type': response.contentType });
            outgoing.end(response.body);
          });
        });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : 0;
          resolve({ close: () => server.close(), port });
        });
      }),
    log: (msg) => console.log(msg),
    openUrl: (url) => launchBrowser(url),
    renderPreview: async (sourcePath) =>
      sharp(await readFile(sourcePath))
        .rotate()
        .resize({ width: LIGHTBOX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer(),
    setTimer: (ms, fn) => {
      const handle = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(handle) };
    },
    transformClient: async (source) => {
      const result = await transform(source, { format: 'esm', loader: 'ts', target: 'es2022' });
      return result.code;
    },
    watchInterrupt: (fn) => {
      process.on('SIGINT', fn);
      return { cancel: () => process.off('SIGINT', fn) };
    },
  };
}
/* v8 ignore stop */
