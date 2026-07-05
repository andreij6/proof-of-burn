import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Principal } from '@icp-sdk/core/principal';
import IcpLp from '../IcpLp';

// ==========================================
// Render tests pinning the OWNER'S copy requirements (2026-07-05):
//  - users see tickets + reclaim-anytime, NOT the yield-distribution split;
//  - the impermanent-loss disclaimer is visible;
//  - ICPSwap is linked for easy navigation.
// These are regression guards: if someone re-adds "50% pot / burn /
// treasury" copy to the page, this suite fails.
// ==========================================

const BACKEND = Principal.fromText('aaaaa-aa');

const info = {
  enabled: true,
  round: 3n,
  tickets_per_round: 10n,
  staked: true,
  backend_principal: BACKEND,
  my_positions: [
    { pool: BACKEND, pool_name: 'ICP/ckUSDC', position_id: 42n, staked_at: 1_700_000_000_000_000_000n },
  ],
  pools: [
    { name: 'ICP/ckUSDC', pool: BACKEND, token0_symbol: 'ICP', token0_ledger: BACKEND, token1_symbol: 'ckUSDC', token1_ledger: BACKEND },
  ],
  total_harvested_icp_e8s: 123_000_000n,
  granted_this_round: true,
  my_reservations: [
    { pool: BACKEND, pool_name: 'ICP/ckUSDC', position_id: 7n, expires_at: 1_900_000_000_000_000_000n },
  ],
};

const actor = { get_icp_lp_info: async () => info };

function signedInPrincipal(): Principal {
  // A non-anonymous principal so the page renders the full signed-in view.
  return Principal.fromText('p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe');
}

async function renderPage() {
  const utils = render(
    <IcpLp actor={actor} principal={signedInPrincipal()} onSignIn={() => {}} onGoParticipate={() => {}} />
  );
  // Wait for the info fetch to land (backend principal appears in step 2
  // and again in the pools card, so findAll).
  await screen.findAllByText(BACKEND.toString());
  return utils;
}

describe('IcpLp page copy (owner requirements)', () => {
  it('tells users they earn tickets and can reclaim anytime — nothing about the split', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/lottery tickets/i);
    expect(text).toMatch(/reclaim|unstake/i);
    expect(text).toMatch(/any ?time/i);
    // The distribution specifics must NOT be user-visible.
    expect(text).not.toContain('50%');
    expect(text).not.toMatch(/treasury/i);
    expect(text).not.toMatch(/\bburn\b/i);
    cleanup();
  });

  it('shows the impermanent-loss disclaimer prominently (not only inside MoreInfo)', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/impermanent loss/i);
    expect(text).toMatch(/not responsible for\s+impermanent loss/i);
    cleanup();
  });

  it('links to ICPSwap for easy navigation', async () => {
    await renderPage();
    const link = document.querySelector('a[href="https://app.icpswap.com/liquidity"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('target')).toBe('_blank');
    cleanup();
  });

  it('has no badge strip above the stake card', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/harvested .* lifetime/i);
    expect(text).not.toMatch(/drawing #\d/);
    cleanup();
  });

  it('walks the RESERVE-FIRST order: reserve here, then transfer on ICPSwap, then confirm', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    // Step order: the reserve instruction precedes the transfer instruction.
    const reserveIdx = text.search(/Reserve it here first/i);
    const transferIdx = text.search(/Transfer Position/i);
    const confirmIdx = text.search(/confirm/i);
    expect(reserveIdx).toBeGreaterThanOrEqual(0);
    expect(transferIdx).toBeGreaterThan(reserveIdx);
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    // A pending reservation renders with its Confirm affordance.
    expect(text).toContain('#7');
    expect(text).toMatch(/Confirm stake/i);
    cleanup();
  });

  it('lists staked positions with an unstake affordance', async () => {
    await renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toContain('ICP/ckUSDC');
    expect(text).toContain('42');
    expect(text).toMatch(/unstake/i);
    cleanup();
  });
});
