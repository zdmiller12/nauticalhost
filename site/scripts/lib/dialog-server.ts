import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
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
  :root { color-scheme: dark; }
  body { background: #11151a; color: #e8edf2; font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
  [data-dialog-stage] { position: relative; display: inline-block; max-width: 100%; cursor: crosshair; touch-action: none; }
  [data-dialog-stage] img { display: block; max-width: 100%; height: auto; }
  [data-dialog-overlay] { position: absolute; inset: 0; }
  [data-dialog-box] { position: absolute; border: 2px solid; box-sizing: border-box; }
  [data-dialog-box][data-active="true"] { outline: 3px solid #7fd1ff; background: rgba(127, 209, 255, .2); }
  [data-dialog-box] span { position: absolute; top: -1.5rem; left: 0; font-size: 12px; padding: 0 .25rem; color: #11151a; }
  [data-dialog-rows] { list-style: none; padding: 0; display: grid; gap: .5rem; }
  [data-dialog-row] { display: flex; gap: .5rem; align-items: center; padding: .5rem; border-radius: .25rem; background: #1b222a; }
  [data-dialog-row][data-active="true"] { outline: 2px solid #7fd1ff; }
  [data-dialog-swatch] { width: 1rem; height: 1rem; border-radius: 2px; flex: none; }
  [data-dialog-existing] { list-style: none; padding: 0; opacity: .6; }
  [data-dialog-warnings]:empty { display: none; }
  [data-dialog-warnings] { background: #3a2c12; border-left: 3px solid #e0a63a; padding: .5rem .75rem; margin: .75rem 0; }
</style>
</head>
<body data-dialog>
<script type="application/json" data-dialog-queue>${data}</script>
<nav>
  <button data-dialog-action="prev" type="button">&larr; Previous</button>
  <span data-dialog-position></span>
  <button data-dialog-action="next" type="button">Next &rarr;</button>
</nav>
<div data-dialog-stage><img data-dialog-image alt="" /><div data-dialog-overlay></div></div>
<p>
  <label>Latitude <input data-dialog-field="latitude" inputmode="decimal" /></label>
  <label>Longitude <input data-dialog-field="longitude" inputmode="decimal" /></label>
</p>
<ul data-dialog-rows></ul>
<button data-dialog-action="add" type="button">Add object without a box</button>
<ul data-dialog-existing></ul>
<div data-dialog-warnings role="status"></div>
<p>
  <button data-dialog-action="submit" type="button">Publish</button>
  <button data-dialog-action="cancel" type="button">Cancel</button>
</p>
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

/** Wires DialogIo to node:http, esbuild, sharp and the real clock. */
/* v8 ignore start -- real sockets, child processes and signal handlers */
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
    openUrl: (url) => {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try {
        spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // Headless or no opener: the URL was printed, which is enough.
      }
    },
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
