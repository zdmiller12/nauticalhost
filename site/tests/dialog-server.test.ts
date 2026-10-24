import { describe, it, expect, vi } from 'vitest';
import {
  handleRequest,
  renderPage,
  runDialog,
  type DialogIo,
  type DialogRequest,
  type DialogResponse,
} from '../scripts/lib/dialog-server';
import { buildQueue, type QueuePhoto } from '../scripts/lib/dialog-session';

const exif = (latitude: number | null, longitude: number | null) =>
  ({ camera: null, date: null, latitude, lens: null, longitude, other: {}, utcOffsetMinutes: null }) as never;

const queue = (): QueuePhoto[] =>
  buildQueue([{ exif: exif(44.1, -68.2), existingYaml: null, slug: 'DSC_0001', sourcePath: 'photos/a.JPG' }]);

const EXISTING_ORGANISM_YAML = `objects:
  - boundingBox: null
    details:
      commonName: "Herring Gull"
      description: null
      inaturalistObservationId: null
      scientificName: "Larus argentatus"
    objectType: organism
`;

const queueWithExistingOrganism = (): QueuePhoto[] =>
  buildQueue([
    { exif: exif(44.1, -68.2), existingYaml: EXISTING_ORGANISM_YAML, slug: 'DSC_0001', sourcePath: 'photos/a.JPG' },
  ]);

function makeIo(overrides: Partial<DialogIo> = {}): DialogIo {
  return {
    clientSource: async () => 'export function initDialog() {}',
    createServer: vi.fn(),
    log: vi.fn(),
    openUrl: vi.fn(),
    renderPreview: async () => Buffer.from('jpeg-bytes'),
    setTimer: () => ({ cancel: vi.fn() }),
    transformClient: async (source: string) => source,
    watchInterrupt: () => ({ cancel: vi.fn() }),
    ...overrides,
  };
}

const request = (overrides: Partial<DialogRequest> = {}): DialogRequest => ({
  body: '',
  method: 'GET',
  url: '/',
  ...overrides,
});

describe('handleRequest', () => {
  it('serves the page at /', async () => {
    const response = await handleRequest(makeIo(), queue(), request(), vi.fn());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/html; charset=utf-8');
    expect(String(response.body)).toContain('data-dialog-stage');
  });

  it('serves the transformed client as a module', async () => {
    const transformClient = vi.fn(async () => 'export function initDialog() {}');
    const response = await handleRequest(makeIo({ transformClient }), queue(), request({ url: '/client.js' }), vi.fn());
    expect(response.contentType).toBe('text/javascript; charset=utf-8');
    expect(transformClient).toHaveBeenCalledOnce();
  });

  it('serves a photo preview as jpeg', async () => {
    const renderPreview = vi.fn(async () => Buffer.from('jpeg-bytes'));
    const response = await handleRequest(makeIo({ renderPreview }), queue(), request({ url: '/photo/0' }), vi.fn());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('image/jpeg');
    expect(renderPreview).toHaveBeenCalledWith('photos/a.JPG');
  });

  it('404s a photo index that is not in the queue', async () => {
    const response = await handleRequest(makeIo(), queue(), request({ url: '/photo/9' }), vi.fn());
    expect(response.status).toBe(404);
  });

  it('404s an unknown path', async () => {
    const response = await handleRequest(makeIo(), queue(), request({ url: '/nope' }), vi.fn());
    expect(response.status).toBe(404);
  });

  it('resolves the session on a valid result POST', async () => {
    const resolve = vi.fn();
    const body = JSON.stringify({
      photos: [{ index: 0, latitude: 44.1, longitude: -68.2, objects: [] }],
    });
    const response = await handleRequest(makeIo(), queue(), request({ body, method: 'POST', url: '/result' }), resolve);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ kind: 'completed', photos: [expect.objectContaining({ slug: 'DSC_0001' })] });
  });

  it('answers 400 with the validation errors and does not resolve', async () => {
    const resolve = vi.fn();
    const body = JSON.stringify({ photos: [{ index: 0, objects: [{ objectType: 'vehicle' }] }] });
    const response = await handleRequest(makeIo(), queue(), request({ body, method: 'POST', url: '/result' }), resolve);
    expect(response.status).toBe(400);
    expect(JSON.parse(String(response.body)).errors[0]).toContain('objectType');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers 409 with duplicates and does not resolve', async () => {
    const resolve = vi.fn();
    const body = JSON.stringify({
      photos: [{ index: 0, objects: [{ objectType: 'organism', scientificName: 'Larus argentatus' }] }],
    });
    const response = await handleRequest(
      makeIo(),
      queueWithExistingOrganism(),
      request({ body, method: 'POST', url: '/result' }),
      resolve
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(String(response.body)).duplicates).toBeInstanceOf(Array);
    expect(JSON.parse(String(response.body)).duplicates.length).toBeGreaterThan(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON', async () => {
    const response = await handleRequest(
      makeIo(),
      queue(),
      request({ body: 'not json', method: 'POST', url: '/result' }),
      vi.fn()
    );
    expect(response.status).toBe(400);
  });

  it('resolves as aborted on a cancel POST', async () => {
    const resolve = vi.fn();
    const response = await handleRequest(makeIo(), queue(), request({ method: 'POST', url: '/cancel' }), resolve);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ kind: 'aborted' });
  });
});

describe('runDialog', () => {
  const handle = () => ({ close: vi.fn(), port: 51234 });

  it('opens the browser, prints the url, and resolves with the posted result', async () => {
    const server = handle();
    let route!: (request: DialogRequest) => Promise<DialogResponse>;
    const io = makeIo({
      createServer: async (handler) => {
        route = handler;
        return server;
      },
    });

    const session = runDialog(io, queue());
    await route(request({ body: JSON.stringify({ photos: [{ index: 0, objects: [] }] }), method: 'POST', url: '/result' }));

    await expect(session).resolves.toEqual({ kind: 'completed', photos: [expect.objectContaining({ slug: 'DSC_0001' })] });
    expect(io.openUrl).toHaveBeenCalledWith('http://localhost:51234/');
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('http://localhost:51234/'));
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('resolves as timeout when the tab is abandoned', async () => {
    const server = handle();
    let fire!: () => void;
    const io = makeIo({
      createServer: async () => server,
      setTimer: (_ms, fn) => {
        fire = fn;
        return { cancel: vi.fn() };
      },
    });
    const session = runDialog(io, queue(), { timeoutMs: 1000 });
    fire();
    await expect(session).resolves.toEqual({ kind: 'timeout' });
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('resolves as aborted when the CLI is interrupted', async () => {
    const server = handle();
    let interrupt!: () => void;
    const io = makeIo({
      createServer: async () => server,
      watchInterrupt: (fn) => {
        interrupt = fn;
        return { cancel: vi.fn() };
      },
    });
    const session = runDialog(io, queue());
    interrupt();
    await expect(session).resolves.toEqual({ kind: 'aborted' });
  });

  it('cancels the timer and the interrupt watcher once settled', async () => {
    const server = handle();
    let route!: (request: DialogRequest) => Promise<DialogResponse>;
    const timerCancel = vi.fn();
    const interruptCancel = vi.fn();
    const io = makeIo({
      createServer: async (handler) => {
        route = handler;
        return server;
      },
      setTimer: () => ({ cancel: timerCancel }),
      watchInterrupt: () => ({ cancel: interruptCancel }),
    });

    const session = runDialog(io, queue());
    await route(request({ method: 'POST', url: '/cancel' }));
    await session;

    expect(timerCancel).toHaveBeenCalledOnce();
    expect(interruptCancel).toHaveBeenCalledOnce();
  });

  it('ignores a second resolution', async () => {
    const server = handle();
    let route!: (request: DialogRequest) => Promise<DialogResponse>;
    const io = makeIo({
      createServer: async (handler) => {
        route = handler;
        return server;
      },
    });

    const session = runDialog(io, queue());
    await route(request({ method: 'POST', url: '/cancel' }));
    await route(request({ method: 'POST', url: '/cancel' }));

    await expect(session).resolves.toEqual({ kind: 'aborted' });
    expect(server.close).toHaveBeenCalledOnce();
  });
});
