import {
  DEFAULT_CURRENCY,
  defaultAccountName,
  distribute,
  formatMoney,
  parseMoney,
  type Account,
} from '../lib/balance-accounts';

const panels = document.querySelectorAll<HTMLElement>('[data-widget-panel]');
const cards = document.querySelectorAll<HTMLButtonElement>('[data-widget-card]');
const summaries = document.querySelectorAll<HTMLElement>('[data-widget-summary]');
const rowsBody = document.getElementById('account-rows');
const rowTemplate = document.getElementById('account-row-template') as HTMLTemplateElement | null;
const amountInput = document.getElementById('amount') as HTMLInputElement | null;
const currencySelect = document.getElementById('currency') as HTMLSelectElement | null;
const addButton = document.getElementById('add-account');
const distributedEl = document.getElementById('total-distributed');
const undistributedEl = document.getElementById('total-undistributed');
const messageEl = document.getElementById('balance-message');

if (
  rowsBody &&
  rowTemplate &&
  amountInput &&
  currencySelect &&
  addButton &&
  distributedEl &&
  undistributedEl &&
  messageEl
) {
  const EM_DASH = '—';

  // --- widget catalog ----------------------------------------------------

  const selectWidget = (id: string): void => {
    for (const panel of panels) panel.hidden = panel.dataset.widgetPanel !== id;
    for (const summary of summaries) summary.hidden = summary.dataset.widgetSummary !== id;
    for (const card of cards) {
      card.setAttribute('aria-expanded', String(card.dataset.widgetCard === id));
    }
  };

  for (const card of cards) {
    card.addEventListener('click', () => selectWidget(card.dataset.widgetCard!));
  }

  // --- balance accounts --------------------------------------------------

  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(rowsBody.querySelectorAll<HTMLTableRowElement>('tr'));

  const field = (row: HTMLTableRowElement, selector: string): HTMLInputElement =>
    row.querySelector<HTMLInputElement>(selector)!;

  const cell = (row: HTMLTableRowElement, selector: string): HTMLElement =>
    row.querySelector<HTMLElement>(selector)!;

  /** Placeholders track position, so they stay A, B, C after an add or remove. */
  const renumber = (): void => {
    rowElements().forEach((row, i) => {
      field(row, '[data-account-name]').placeholder = defaultAccountName(i);
    });
  };

  const clearResults = (): void => {
    for (const row of rowElements()) {
      cell(row, '[data-account-share]').textContent = EM_DASH;
      cell(row, '[data-account-total]').textContent = EM_DASH;
    }
    distributedEl.textContent = EM_DASH;
    undistributedEl.textContent = EM_DASH;
  };

  const recalculate = (): void => {
    const code = currencySelect.value;
    const rows = rowElements();

    const amountMinor = parseMoney(amountInput.value, code);
    const balances = rows.map((row) => parseMoney(field(row, '[data-account-balance]').value, code));
    if (amountMinor === null || balances.some((b) => b === null)) {
      clearResults();
      messageEl.textContent = 'Enter a valid, non-negative number for the amount and each balance.';
      return;
    }

    const accounts: Account[] = rows.map((row, i) => ({
      balanceMinor: balances[i]!,
      name: field(row, '[data-account-name]').value.trim() || defaultAccountName(i),
    }));

    const { shares, undistributedMinor } = distribute(accounts, amountMinor);
    rows.forEach((row, i) => {
      cell(row, '[data-account-share]').textContent = formatMoney(shares[i], code);
      cell(row, '[data-account-total]').textContent = formatMoney(
        accounts[i].balanceMinor + shares[i],
        code,
      );
    });
    distributedEl.textContent = formatMoney(amountMinor - undistributedMinor, code);
    undistributedEl.textContent = formatMoney(undistributedMinor, code);

    // Either every account reached the same total, or the money ran out and
    // some accounts are still ahead of the rest. Compare the resulting totals
    // exactly: the undistributed remainder is not slack, since an account can
    // sit a single minor unit above the level the others were filled to.
    const newTotals = accounts.map((account, i) => account.balanceMinor + shares[i]);
    const lowest = Math.min(...newTotals);
    if (newTotals.every((total) => total === lowest)) {
      messageEl.textContent = `Every account ends at ${formatMoney(lowest, code)}.`;
      return;
    }
    const ahead = accounts.filter((_, i) => newTotals[i] > lowest).map((account) => account.name);
    messageEl.textContent =
      `Not enough to level every account — ${ahead.join(', ')} ` +
      `${ahead.length === 1 ? 'is' : 'are'} still above the others.`;
  };

  const addRow = (): void => {
    // The template wraps its row in a table (see widgets.astro); take the <tr>.
    rowsBody.appendChild(rowTemplate.content.querySelector('tr')!.cloneNode(true));
    renumber();
  };

  rowsBody.addEventListener('input', recalculate);
  rowsBody.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-remove-account]');
    // Two accounts is the minimum this widget is meaningful at.
    if (!button || rowElements().length <= 2) return;
    button.closest('tr')!.remove();
    renumber();
    recalculate();
  });
  addButton.addEventListener('click', () => {
    addRow();
    recalculate();
  });
  amountInput.addEventListener('input', recalculate);
  currencySelect.addEventListener('change', recalculate);

  currencySelect.value = DEFAULT_CURRENCY;
  addRow();
  addRow();
  clearResults();
}
