import { describe, expect, it } from 'vitest';
import {
  FriendlyError, SOMETHING_WRONG, friendlyFromRaw, logRealError, readErrorLog, clearErrorLog, toFriendly,
} from '../errors';

describe('friendlyFromRaw', () => {
  it('translates known backend codes to plain English', () => {
    expect(friendlyFromRaw('BOND_EXIT_ONLY: exits are bond-native')).toContain('Stake Bond');
    expect(friendlyFromRaw('POOL_FLOOR')).toContain('1 ICP');
    expect(friendlyFromRaw('Anonymous principal is not allowed')).toContain('sign in');
  });

  it('translates ledger + agent errors embedded in JSON/reject strings', () => {
    expect(friendlyFromRaw('{"__kind__":"InsufficientFunds","InsufficientFunds":{"balance":"5"}}')).toContain('network fee');
    expect(friendlyFromRaw('reject: Specified sender delegation has expired')).toContain('session expired');
  });

  it('orders specific needles before their prefixes', () => {
    expect(friendlyFromRaw('ALREADY_CLAIMED_TODAY')).toContain('tomorrow');
    expect(friendlyFromRaw('ALREADY_CLAIMED')).toContain('one per account');
  });

  it('falls back to "Something went wrong" for unknown errors', () => {
    expect(friendlyFromRaw('WEIRD_INTERNAL_CODE_42')).toBe(SOMETHING_WRONG);
  });
});

describe('toFriendly + the error log', () => {
  it('passes FriendlyError messages through untranslated', () => {
    expect(toFriendly(new FriendlyError('Enter an ask in ICP.'), 't')).toBe('Enter an ask in ICP.');
  });

  it('translates unknown thrown errors and logs the raw text', () => {
    clearErrorLog();
    expect(toFriendly(new Error('EXPLODED_INTERNALLY xyz'), 'test-ctx')).toBe(SOMETHING_WRONG);
    const log = readErrorLog();
    expect(log.length).toBe(1);
    expect(log[0].context).toBe('test-ctx');
    expect(log[0].error).toContain('EXPLODED_INTERNALLY');
    clearErrorLog();
  });

  it('caps the ring buffer at 100 entries', () => {
    clearErrorLog();
    for (let i = 0; i < 120; i++) logRealError('cap', `e${i}`);
    const log = readErrorLog();
    expect(log.length).toBe(100);
    expect(log[0].error).toBe('e20');
    clearErrorLog();
  });
});
