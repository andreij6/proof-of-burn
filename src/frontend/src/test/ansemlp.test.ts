import { describe, it, expect } from 'vitest';
import { lpChallengeMessage, friendlyLpErr } from '../AnsemLp';

describe('LP challenge message', () => {
  it('matches the backend format byte-for-byte (lp_challenge_message twin)', () => {
    // Backend: format!("Cycle Burn LP verification\nprincipal: {}\nround: {}\nnonce: {}\nexpires_ns: {}")
    expect(lpChallengeMessage('aaaaa-aa', 7n, 42n, 1700000000000000000n)).toBe(
      'Cycle Burn LP verification\nprincipal: aaaaa-aa\nround: 7\nnonce: 42\nexpires_ns: 1700000000000000000'
    );
  });
});

describe('friendlyLpErr', () => {
  it('maps the gate codes to actionable copy', () => {
    expect(friendlyLpErr('NOT_STAKED')).toContain('stake');
    expect(friendlyLpErr('NO_WALLET_LINKED')).toContain('Link');
    expect(friendlyLpErr('ALREADY_CLAIMED_THIS_ROUND')).toContain('drawing');
    expect(friendlyLpErr('NO_QUALIFYING_LP')).toContain('ANSEM');
    expect(friendlyLpErr('OTHER')).toBe('OTHER');
  });
});
