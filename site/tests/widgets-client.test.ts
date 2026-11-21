// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mirrors the parts of src/pages/widgets.astro the client script binds to.
function renderMarkup(): void {
  document.body.innerHTML = `
    <ul>
      <li>
        <button type="button" data-widget-card="balance-accounts" aria-expanded="true"
                aria-controls="widget-panel-balance-accounts">Balance Accounts
          <span data-widget-chevron>&#9656;</span>
        </button>
        <p data-widget-summary="balance-accounts">Distribute a sum.</p>
      </li>
      <li>
        <button type="button" data-widget-card="other" aria-expanded="false"
                aria-controls="widget-panel-other">Other
          <span data-widget-chevron>&#9656;</span>
        </button>
        <p data-widget-summary="other" hidden>Something else.</p>
      </li>
    </ul>
    <section id="widget-panel-balance-accounts" data-widget-panel="balance-accounts">
      <select id="currency">
        <option value="USD" selected>USD</option>
        <option value="JPY">JPY</option>
      </select>
      <input id="amount" type="text" />
      <table><tbody id="account-rows"></tbody></table>
      <button id="add-account" type="button">Add account</button>
      <dd id="total-distributed">&mdash;</dd>
      <dd id="total-undistributed">&mdash;</dd>
      <p id="balance-message"></p>
    </section>
    <section id="widget-panel-other" data-widget-panel="other" hidden></section>
    <template id="account-row-template">
      <table><tbody>
      <tr>
        <td><input type="text" data-account-name /></td>
        <td><input type="text" data-account-balance /></td>
        <td data-account-share>&mdash;</td>
        <td data-account-total>&mdash;</td>
        <td><button type="button" data-remove-account>&#10005;</button></td>
      </tr>
      </tbody></table>
    </template>
  `;
}

async function loadModule(): Promise<void> {
  vi.resetModules();
  await import('../src/scripts/widgets-client');
}

const rows = (): HTMLTableRowElement[] =>
  Array.from(document.querySelectorAll<HTMLTableRowElement>('#account-rows tr'));
const nameInputs = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>('[data-account-name]'));
const shares = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-account-share]')).map((el) => el.textContent);
const totals = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-account-total]')).map((el) => el.textContent);
const text = (id: string): string | null => document.getElementById(id)!.textContent;

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setBalances(...values: string[]): void {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-account-balance]'));
  values.forEach((value, i) => type(inputs[i], value));
}

function setAmount(value: string): void {
  type(document.getElementById('amount') as HTMLInputElement, value);
}

function addAccount(): void {
  document.getElementById('add-account')!.dispatchEvent(new Event('click', { bubbles: true }));
}

describe('widgets-client', () => {
  beforeEach(async () => {
    renderMarkup();
    await loadModule();
  });

  it('starts with two accounts named A and B', () => {
    expect(rows()).toHaveLength(2);
    expect(nameInputs().map((i) => i.placeholder)).toEqual(['Account A', 'Account B']);
  });

  it('solves request example A: levels both accounts', () => {
    setBalances('10', '20');
    setAmount('12');
    expect(shares()).toEqual(['$11.00', '$1.00']);
    expect(totals()).toEqual(['$21.00', '$21.00']);
    expect(text('total-distributed')).toBe('$12.00');
    expect(text('total-undistributed')).toBe('$0.00');
  });

  it('solves request example B: exhausts the amount before accounts are equal', () => {
    setBalances('10', '20');
    setAmount('5');
    expect(shares()).toEqual(['$5.00', '$0.00']);
    expect(totals()).toEqual(['$15.00', '$20.00']);
    expect(text('total-distributed')).toBe('$5.00');
    expect(text('total-undistributed')).toBe('$0.00');
  });

  it('reports a sub-cent remainder as the amount not distributed', () => {
    addAccount();
    setBalances('0', '0', '0');
    setAmount('1');
    expect(shares()).toEqual(['$0.33', '$0.33', '$0.33']);
    expect(text('total-distributed')).toBe('$0.99');
    expect(text('total-undistributed')).toBe('$0.01');
  });

  it('says so when every account ends up level', () => {
    setBalances('10', '20');
    setAmount('12');
    expect(text('balance-message')).toContain('$21.00');
  });

  it('says so when the amount runs out before accounts are level', () => {
    setBalances('10', '20');
    setAmount('5');
    expect(text('balance-message')).toMatch(/not enough/i);
  });

  it('adds an account, named for its position', () => {
    addAccount();
    addAccount();
    expect(rows()).toHaveLength(4);
    expect(nameInputs()[3].placeholder).toBe('Account D');
  });

  it('removes an account and recalculates without it', () => {
    addAccount();
    setBalances('10', '20', '0');
    setAmount('12');
    const removeThird = document.querySelectorAll('[data-remove-account]')[2] as HTMLButtonElement;
    removeThird.dispatchEvent(new Event('click', { bubbles: true }));
    expect(rows()).toHaveLength(2);
    expect(shares()).toEqual(['$11.00', '$1.00']);
  });

  it('keeps at least two accounts, refusing to remove the last of them', () => {
    const remove = document.querySelectorAll('[data-remove-account]')[0] as HTMLButtonElement;
    remove.dispatchEvent(new Event('click', { bubbles: true }));
    remove.dispatchEvent(new Event('click', { bubbles: true }));
    expect(rows()).toHaveLength(2);
  });

  it('renumbers placeholder names after a removal', () => {
    addAccount();
    const removeSecond = document.querySelectorAll('[data-remove-account]')[1] as HTMLButtonElement;
    removeSecond.dispatchEvent(new Event('click', { bubbles: true }));
    expect(nameInputs().map((i) => i.placeholder)).toEqual(['Account A', 'Account B']);
  });

  it('treats a blank balance as zero', () => {
    setBalances('', '20');
    setAmount('20');
    expect(shares()).toEqual(['$20.00', '$0.00']);
  });

  it('flags unreadable input instead of calculating with it', () => {
    setBalances('abc', '20');
    setAmount('12');
    expect(text('balance-message')).toMatch(/valid/i);
    expect(shares()).toEqual(['—', '—']);
  });

  it('recalculates in the chosen currency, respecting its sub-unit', () => {
    setBalances('1000', '2000');
    setAmount('1200');
    const currency = document.getElementById('currency') as HTMLSelectElement;
    currency.value = 'JPY';
    currency.dispatchEvent(new Event('change'));
    expect(shares()).toEqual(['¥1,100', '¥100']);
    expect(text('total-undistributed')).toBe('¥0');
  });

  it('names an untouched account by its typed name, not its placeholder', () => {
    type(nameInputs()[1], 'Savings');
    setBalances('10', '20');
    setAmount('5');
    expect(text('balance-message')).toContain('Savings');
    expect(text('balance-message')).not.toContain('Account B');
  });

  it('names every account still ahead when more than one gets nothing', () => {
    addAccount();
    setBalances('10', '20', '30');
    setAmount('5');
    expect(text('balance-message')).toContain('Account B, Account C');
    expect(text('balance-message')).toContain('are still above');
  });

  // An undistributed cent must not be read as slack in the level check: here
  // the three filled accounts reach $0.03 while D sits a cent higher at $0.04.
  it('does not call accounts level when one is a single cent ahead', () => {
    addAccount();
    addAccount();
    setBalances('0', '0', '0', '0.04');
    setAmount('0.10');
    expect(text('total-undistributed')).toBe('$0.01');
    expect(text('balance-message')).toMatch(/not enough/i);
    expect(text('balance-message')).toContain('Account D');
  });

  it('names an account that is ahead even when nothing at all is distributed', () => {
    setBalances('10', '20');
    setAmount('0');
    expect(text('balance-message')).toContain('Account B');
    expect(text('balance-message')).toMatch(/not enough/i);
  });

  it('shows the selected widget and hides the others', () => {
    const otherCard = document.querySelector('[data-widget-card="other"]') as HTMLButtonElement;
    otherCard.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.getElementById('widget-panel-other')!.hidden).toBe(false);
    expect(document.getElementById('widget-panel-balance-accounts')!.hidden).toBe(true);
    expect(otherCard.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector('[data-widget-card="balance-accounts"]')!.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('reveals the selected widget summary and collapses the previous one', () => {
    const otherCard = document.querySelector('[data-widget-card="other"]') as HTMLButtonElement;
    otherCard.dispatchEvent(new Event('click', { bubbles: true }));
    expect((document.querySelector('[data-widget-summary="other"]') as HTMLElement).hidden).toBe(false);
    expect(
      (document.querySelector('[data-widget-summary="balance-accounts"]') as HTMLElement).hidden,
    ).toBe(true);
  });

  it('does nothing when the widgets markup is absent', async () => {
    document.body.innerHTML = '<div>not the widgets page</div>';
    await expect(loadModule()).resolves.toBeUndefined();
  });
});
