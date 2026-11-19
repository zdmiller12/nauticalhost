import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  WIDGETS,
  currencyOptions,
  defaultAccountName,
  formatMoney,
  minorUnitDigits,
  parseMoney,
} from '../src/lib/balance-accounts';

describe('minorUnitDigits', () => {
  it('uses 2 digits for USD', () => {
    expect(minorUnitDigits('USD')).toBe(2);
  });

  it('uses 0 digits for currencies with no sub-unit', () => {
    expect(minorUnitDigits('JPY')).toBe(0);
  });

  it('uses 3 digits for currencies with a thousandth sub-unit', () => {
    expect(minorUnitDigits('KWD')).toBe(3);
  });
});

describe('parseMoney', () => {
  it('converts a decimal amount to minor units', () => {
    expect(parseMoney('10.50', 'USD')).toBe(1050);
  });

  it('reads a whole number as major units', () => {
    expect(parseMoney('12', 'USD')).toBe(1200);
  });

  it('pads a short fraction out to the full sub-unit', () => {
    expect(parseMoney('3.4', 'USD')).toBe(340);
  });

  it('parses exactly, without floating-point drift', () => {
    expect(parseMoney('8.165', 'KWD')).toBe(8165);
    expect(parseMoney('1234.56', 'USD')).toBe(123456);
  });

  it('rounds a fraction finer than the sub-unit to the nearest minor unit', () => {
    expect(parseMoney('1.005', 'USD')).toBe(101);
    expect(parseMoney('1.004', 'USD')).toBe(100);
  });

  it('ignores a fraction entirely for a currency with no sub-unit', () => {
    expect(parseMoney('1234.99', 'JPY')).toBe(1235);
    expect(parseMoney('1234', 'JPY')).toBe(1234);
  });

  it('accepts thousands separators and surrounding whitespace', () => {
    expect(parseMoney('  1,234.56 ', 'USD')).toBe(123456);
  });

  it('treats a blank input as zero', () => {
    expect(parseMoney('', 'USD')).toBe(0);
    expect(parseMoney('   ', 'USD')).toBe(0);
  });

  it('rejects non-numeric input', () => {
    expect(parseMoney('abc', 'USD')).toBeNull();
    expect(parseMoney('1.2.3', 'USD')).toBeNull();
    expect(parseMoney('$5', 'USD')).toBeNull();
  });

  it('rejects negative input, since balances and amounts cannot be negative', () => {
    expect(parseMoney('-5', 'USD')).toBeNull();
  });
});

describe('formatMoney', () => {
  it('renders minor units as a currency string', () => {
    expect(formatMoney(1100, 'USD')).toBe('$11.00');
  });

  it('renders a zero remainder rather than an empty string', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });

  it('omits decimals for a currency with no sub-unit', () => {
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
  });
});

describe('currencyOptions', () => {
  it('lists every currency the runtime knows, with a readable label', () => {
    const options = currencyOptions();
    expect(options.length).toBeGreaterThan(100);
    expect(options).toContainEqual({ code: 'USD', label: 'USD — US Dollar' });
  });

  it('lists currencies in alphabetical order by code', () => {
    const codes = currencyOptions().map((o) => o.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('defaults to US dollars', () => {
    expect(DEFAULT_CURRENCY).toBe('USD');
    expect(currencyOptions().some((o) => o.code === DEFAULT_CURRENCY)).toBe(true);
  });
});

describe('defaultAccountName', () => {
  it('names the first accounts A, B, C', () => {
    expect(defaultAccountName(0)).toBe('Account A');
    expect(defaultAccountName(1)).toBe('Account B');
    expect(defaultAccountName(2)).toBe('Account C');
  });

  it('wraps past Z the way spreadsheet columns do', () => {
    expect(defaultAccountName(25)).toBe('Account Z');
    expect(defaultAccountName(26)).toBe('Account AA');
    expect(defaultAccountName(27)).toBe('Account AB');
    expect(defaultAccountName(51)).toBe('Account AZ');
    expect(defaultAccountName(52)).toBe('Account BA');
  });
});

describe('WIDGETS', () => {
  it('registers the balance-accounts widget with a summary for its catalog card', () => {
    expect(WIDGETS[0].id).toBe('balance-accounts');
    expect(WIDGETS[0].name).toBe('Balance Accounts');
    expect(WIDGETS[0].summary.length).toBeGreaterThan(0);
  });

  it('gives every widget a unique id', () => {
    const ids = WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('credits the motivating book in the balance-accounts intro', () => {
    const intro = WIDGETS[0].intro ?? '';
    expect(intro).toContain('Yes, You Can!');
    expect(intro).toContain(
      'https://www.hachettebookgroup.com/titles/sam-deep/yes-you-can/9780201479652/?lens=basic-books',
    );
  });

  // WidgetPanel renders the intro as an <aside>, which assistive tech exposes
  // as a landmark. An unnamed one is announced as a bare "complementary", so a
  // widget that writes intro copy owes it a label.
  it('names the intro box of every widget that has one', () => {
    for (const { intro, introLabel } of WIDGETS) {
      if (!intro) continue;
      expect(introLabel?.trim()).toBeTruthy();
    }
  });

  // The box spans the whole column, which fits about this much 14px copy on one
  // line. Muted text that long is fine for a line or two and turns into a slab
  // past that, so intro copy gets a two-line budget: a brief note, not a
  // paragraph. Narrow viewports wrap sooner, so this is a length budget rather
  // than a promise about how many lines render.
  const INTRO_CHARS_PER_LINE = 112;
  const INTRO_MAX_LINES = 2;

  it('keeps every widget intro short enough to stay a note', () => {
    for (const { intro } of WIDGETS) {
      if (!intro) continue;
      // Count what renders: inline tags add no text, and HTML collapses runs of
      // whitespace, so copy written across several source lines isn't charged
      // for its own indentation.
      const visible = intro
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      expect(visible.length).toBeLessThanOrEqual(INTRO_CHARS_PER_LINE * INTRO_MAX_LINES);
    }
  });

  // Intro copy goes through `set:html`, so a link without these two attributes
  // would open in-place or leak the referrer.
  it('opens every intro link safely in a new tab', () => {
    for (const { intro } of WIDGETS) {
      for (const anchor of intro?.match(/<a\b[^>]*>/g) ?? []) {
        expect(anchor).toContain('target="_blank"');
        expect(anchor).toContain('rel="noopener noreferrer"');
      }
    }
  });
});
