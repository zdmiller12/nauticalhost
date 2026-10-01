// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

function renderNavs(): void {
  document.body.innerHTML = `
    <nav data-sort-nav="date">
      <a rel="prev" href="/compendium/photos/newer">Previous</a>
      <a rel="next" href="/compendium/photos/older">Next</a>
    </nav>
    <nav data-sort-nav="tier" hidden>
      <span>Previous</span>
      <a rel="next" href="/compendium/photos/worse?sort=tier">Next</a>
    </nav>
    <input id="search" />
  `;
}

async function loadModule(search = ''): Promise<void> {
  window.history.replaceState(null, '', `/compendium/photos/x${search}`);
  vi.resetModules();
  await import('../src/scripts/photo-nav');
}

const nav = (key: string) => document.querySelector<HTMLElement>(`[data-sort-nav="${key}"]`)!;

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init });
  target.dispatchEvent(event);
  return event;
}

function spyOnLinks(): Record<string, ReturnType<typeof vi.fn>> {
  const clicks: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[rel]')) {
    const spy = vi.fn();
    link.click = spy;
    clicks[`${link.closest('nav')!.dataset.sortNav}:${link.rel}`] = spy;
  }
  return clicks;
}

describe('photo-nav', () => {
  beforeEach(renderNavs);

  it('shows the nav for the default sort when there is no ?sort=', async () => {
    await loadModule();
    expect(nav('date').hidden).toBe(false);
    expect(nav('tier').hidden).toBe(true);
  });

  it('shows the nav matching ?sort=', async () => {
    await loadModule('?sort=tier');
    expect(nav('date').hidden).toBe(true);
    expect(nav('tier').hidden).toBe(false);
  });

  it('follows prev/next with the arrow keys in the active order', async () => {
    const clicks = spyOnLinks();
    await loadModule();
    press('ArrowLeft');
    press('ArrowRight');
    expect(clicks['date:prev']).toHaveBeenCalledOnce();
    expect(clicks['date:next']).toHaveBeenCalledOnce();
    expect(clicks['tier:next']).not.toHaveBeenCalled();
  });

  it('does nothing at the end of the sequence', async () => {
    const clicks = spyOnLinks();
    await loadModule('?sort=tier');
    expect(() => press('ArrowLeft')).not.toThrow();
    press('ArrowRight');
    expect(clicks['tier:next']).toHaveBeenCalledOnce();
  });

  it('ignores other keys, modified arrows, typing, and keys already claimed', async () => {
    const clicks = spyOnLinks();
    await loadModule();

    press('Enter');
    press('ArrowRight', { altKey: true });
    press('ArrowRight', { ctrlKey: true });
    press('ArrowRight', { metaKey: true });
    press('ArrowRight', { shiftKey: true });
    press('ArrowRight', {}, document.getElementById('search')!);

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    press('ArrowRight', {}, editable);

    const claimed = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' });
    claimed.preventDefault();
    document.body.dispatchEvent(claimed);

    press('ArrowRight', {}, document); // a non-element target (focus on the document itself)
    expect(clicks['date:next']).toHaveBeenCalledOnce(); // only that last, plain press
  });

  it('does nothing when the page has no nav', async () => {
    document.body.innerHTML = '';
    await loadModule();
    expect(() => press('ArrowRight')).not.toThrow();
  });
});
