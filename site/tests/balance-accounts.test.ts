import { describe, it, expect } from 'vitest';
import { distribute, type Account } from '../src/lib/balance-accounts';

const accounts = (...balances: number[]): Account[] =>
  balances.map((balanceMinor, i) => ({ balanceMinor, name: `Account ${i}` }));

describe('distribute', () => {
  // The two worked examples from the feature request, in cents.
  it('levels unequal accounts to a common total (request example A)', () => {
    const result = distribute(accounts(1000, 2000), 1200);
    expect(result.shares).toEqual([1100, 100]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('gives everything to the lowest account when the amount runs out first (request example B)', () => {
    const result = distribute(accounts(1000, 2000), 500);
    expect(result.shares).toEqual([500, 0]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('splits the surplus evenly once all accounts are level', () => {
    const result = distribute(accounts(1000, 2000), 3000);
    expect(result.shares).toEqual([2000, 1000]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('reports the sub-unit remainder it cannot split as undistributed', () => {
    const result = distribute(accounts(0, 0, 0), 100);
    expect(result.shares).toEqual([33, 33, 33]);
    expect(result.undistributedMinor).toBe(1);
  });

  it('keeps the input order of accounts in the returned shares', () => {
    const result = distribute(accounts(2000, 1000), 1200);
    expect(result.shares).toEqual([100, 1100]);
  });

  it('fills the two lowest of three accounts before touching the highest', () => {
    const result = distribute(accounts(1000, 2000, 5000), 3000);
    expect(result.shares).toEqual([2000, 1000, 0]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('treats tied balances identically', () => {
    const result = distribute(accounts(1000, 1000, 3000), 1000);
    expect(result.shares).toEqual([500, 500, 0]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('distributes nothing when the amount is zero', () => {
    const result = distribute(accounts(1000, 2000), 0);
    expect(result.shares).toEqual([0, 0]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('clamps a negative amount to zero rather than withdrawing funds', () => {
    const result = distribute(accounts(1000, 2000), -500);
    expect(result.shares).toEqual([0, 0]);
    expect(result.undistributedMinor).toBe(0);
  });

  it('cannot distribute anything with no accounts', () => {
    const result = distribute([], 1200);
    expect(result.shares).toEqual([]);
    expect(result.undistributedMinor).toBe(1200);
  });

  it('never spends more or less than the amount, for any input', () => {
    const balanceSets = [
      [0],
      [7],
      [0, 0],
      [1, 999],
      [500, 500, 500],
      [1, 2, 3, 4, 5],
      [10000, 1, 73, 73, 2500],
    ];
    for (const balances of balanceSets) {
      for (const amount of [0, 1, 2, 7, 99, 1000, 123457]) {
        const { shares, undistributedMinor } = distribute(accounts(...balances), amount);
        const spent = shares.reduce((sum, s) => sum + s, 0);
        expect(spent + undistributedMinor).toBe(amount);
        expect(undistributedMinor).toBeLessThan(balances.length);
        expect(shares.every((s) => s >= 0 && Number.isInteger(s))).toBe(true);
      }
    }
  });
});
