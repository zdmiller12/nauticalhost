import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn().mockResolvedValue(undefined) };
});

import { mkdir } from 'node:fs/promises';
import { createRealCliIo } from '../scripts/lib/cli';

describe('createRealCliIo', () => {
  it('passes through the real process argv and env', () => {
    const io = createRealCliIo();
    expect(io.argv).toBe(process.argv);
    expect(io.env).toBe(process.env);
  });

  it('logs and errors through console.log/console.error', () => {
    const io = createRealCliIo();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    io.log('hello');
    io.error('oops');

    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(errorSpy).toHaveBeenCalledWith('oops');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('creates directories recursively', async () => {
    const io = createRealCliIo();
    await io.mkdir('some/nested/dir');
    expect(mkdir).toHaveBeenCalledWith('some/nested/dir', { recursive: true });
  });
});
