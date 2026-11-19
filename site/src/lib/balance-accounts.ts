/**
 * Balance Accounts widget: distribute a pot of money across accounts so their
 * totals end up as equal as possible.
 *
 * All money is handled in a currency's minor units (cents for USD, whole yen
 * for JPY) so the arithmetic stays in integers and never drifts.
 */

export interface Account {
  balanceMinor: number;
  name: string;
}

export interface CurrencyOption {
  code: string;
  label: string;
}

export interface Widget {
  id: string;
  /**
   * Optional HTML rendered at the top of the widget's expanded panel, above
   * its controls. Authored here, never user-supplied, so WidgetPanel.astro
   * can hand it straight to `set:html`.
   */
  intro?: string;
  name: string;
  summary: string;
}

export const DEFAULT_CURRENCY = 'USD';

/** The widget catalog. Adding a widget is one entry here plus its panel markup. */
export const WIDGETS: Widget[] = [
  {
    id: 'balance-accounts',
    intro:
      'Inspired by the financial strategy in <a href="https://www.hachettebookgroup.com/titles/sam-deep/yes-you-can/9780201479652/?lens=basic-books" target="_blank" rel="noopener noreferrer" class="underline hover:text-clay">Yes, You Can!</a> by Sam Deep and Lyle Sussman.',
    name: 'Balance Accounts',
    summary:
      'Distribute a sum across several accounts so their totals end up equal — or as close to equal as the money allows.',
  },
];

export interface Distribution {
  /** Minor units given to each account, index-aligned with the input. */
  shares: number[];
  /**
   * Minor units that could not be handed out, because splitting them further
   * would need a fraction of a cent. Always less than the account count.
   */
  undistributedMinor: number;
}

/**
 * Water-filling: find the level L where `sum(max(0, L - balance)) === amount`,
 * then give each account `L - balance`. Walks the balances in ascending order,
 * raising the waterline one tier at a time, which is O(n log n) and needs no
 * search. Once every account is level the leftover splits evenly, so a surplus
 * needs no special case.
 */
export function distribute(accounts: Account[], amountMinor: number): Distribution {
  const shares = accounts.map(() => 0);
  let remaining = Math.max(0, Math.trunc(amountMinor));
  if (accounts.length === 0) return { shares, undistributedMinor: remaining };

  // Ascending by balance: the lowest accounts are filled first.
  const order = accounts.map((_, i) => i).sort((a, b) => accounts[a].balanceMinor - accounts[b].balanceMinor);

  // `filled` accounts order[0..i] have all been topped up to `level`.
  let i = 0;
  let level = accounts[order[0]].balanceMinor;
  for (;;) {
    const filled = i + 1;
    if (filled < accounts.length) {
      const nextLevel = accounts[order[filled]].balanceMinor;
      const costToNextTier = (nextLevel - level) * filled;
      // Tied balances cost 0 to absorb, which folds them into the same tier.
      if (remaining >= costToNextTier) {
        remaining -= costToNextTier;
        level = nextLevel;
        i = filled;
        continue;
      }
    }
    // Not enough left to reach the next tier (or no tier left): spread what
    // remains evenly, keeping back whatever cannot divide into whole units.
    const perAccount = Math.floor(remaining / filled);
    level += perAccount;
    remaining -= perAccount * filled;
    break;
  }

  for (let j = 0; j <= i; j += 1) {
    shares[order[j]] = level - accounts[order[j]].balanceMinor;
  }
  return { shares, undistributedMinor: remaining };
}

const digitsByCurrency = new Map<string, number>();

/**
 * How many decimal places a currency's minor unit uses: 2 for USD (cents),
 * 0 for JPY (no sub-unit), 3 for KWD (fils). Read from the runtime rather
 * than hardcoded, so the whole ISO list behaves correctly.
 */
export function minorUnitDigits(code: string): number {
  const cached = digitsByCurrency.get(code);
  if (cached !== undefined) return cached;
  const digits = new Intl.NumberFormat('en-US', {
    currency: code,
    style: 'currency',
  }).resolvedOptions().maximumFractionDigits;
  digitsByCurrency.set(code, digits);
  return digits;
}

/**
 * Parse a typed amount into minor units, or null if it is not a plain
 * non-negative number. Works on the digit string rather than multiplying a
 * float, so `8.165` cannot land on 8164.999…; a fraction finer than the
 * currency's sub-unit rounds half-up.
 */
export function parseMoney(text: string, code: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!/^(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.replace(/,/g, '').split('.');
  const digits = minorUnitDigits(code);
  const minor = Number(whole + fraction.slice(0, digits).padEnd(digits, '0'));
  // The first dropped digit decides the rounding; NaN when there isn't one.
  const nextDigit = fraction.charCodeAt(digits) - 48;
  return nextDigit >= 5 ? minor + 1 : minor;
}

/** Render minor units as a currency string, e.g. 1100 USD -> "$11.00". */
export function formatMoney(amountMinor: number, code: string): string {
  const digits = minorUnitDigits(code);
  return new Intl.NumberFormat('en-US', { currency: code, style: 'currency' }).format(
    amountMinor / 10 ** digits,
  );
}

/** Every currency this runtime knows, alphabetical by code, for the picker. */
export function currencyOptions(): CurrencyOption[] {
  const names = new Intl.DisplayNames(['en'], { type: 'currency' });
  return Intl.supportedValuesOf('currency')
    .slice()
    .sort()
    .map((code) => ({ code, label: `${code} — ${names.of(code)!}` }));
}

/** Account A, B, … Z, AA, AB — the placeholder name for an unnamed account. */
export function defaultAccountName(index: number): string {
  let remaining = index;
  let letters = '';
  for (;;) {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    if (remaining < 26) return `Account ${letters}`;
    remaining = Math.floor(remaining / 26) - 1;
  }
}
