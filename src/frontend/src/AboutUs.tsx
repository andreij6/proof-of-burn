import React from 'react';
import type { AppPage } from "./App";
import { Icon, Eyebrow, Btn } from "./ui";

// Mission Statement — the project's purpose, the vision for where it's headed,
// and a call to fellow ICP builders. Static, self-contained (no actor needed).

interface AboutUsProps {
  signedIn: boolean;
  onSignIn: () => void;
  go: (p: AppPage) => void;
}

const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  padding: '16px 18px', borderRadius: 12,
  background: 'var(--surface)', border: '1px solid var(--border)',
};

function Pillar({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name={icon} size={15} stroke="var(--burn-ink)" />
        <b style={{ fontSize: 14 }}>{title}</b>
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

export default function AboutUs({ signedIn, onSignIn, go }: AboutUsProps) {
  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <Eyebrow accent>Mission Statement</Eyebrow>
        <span className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Icon name="flame" size={22} stroke="var(--burn-ink)" />
          <h4 style={{ margin: 0 }}>Why Caldera exists</h4>
        </span>
        <p style={{ fontSize: 13.5, color: 'var(--fg-2)', maxWidth: 660, lineHeight: 1.6 }}>
          Caldera is a community-owned governance layer on the Internet Computer. We turn collective
          conviction into real NNS voting power — and we make every action <b style={{ color: 'var(--fg)' }}>provably
          shrink the ICP supply</b>. No custody, no lock-ups you can't reverse, no promises we can't settle on-chain.
        </p>
      </div>

      {/* ── Purpose ── */}
      <div className="col" style={{ gap: 10 }}>
        <Eyebrow>Our purpose</Eyebrow>
        <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, maxWidth: 700, margin: 0 }}>
          A handful of large neurons decide most NNS proposals. Caldera gives the rest of us a way to
          matter: pool our voice behind a community leader neuron, and back the proposals we care about
          by burning ICP. The burn is the point — it permanently removes ICP from circulation, so
          steering governance and strengthening the token's economics become the same act.
        </p>
        <div className="hub-grid" style={{ marginTop: 4 }}>
          <Pillar icon="flame" title="Burn to steer">
            Commit ICP behind ADOPT or REJECT. Meet the threshold and the leader neuron votes your way —
            while every committed token is burned forever.
          </Pillar>
          <Pillar icon="coins" title="The Neuron Syndicate">
            Verify your own NNS neuron follows the leader and earn a share of every protocol burn,
            paid in ICP. Your stake keeps working for you with nothing locked away.
          </Pillar>
          <Pillar icon="zap" title="Lossless staking">
            Stake ICP in fixed terms to earn daily lottery tickets. Withdraw exactly what you put in —
            only the neuron yield funds the lottery and the treasury.
          </Pillar>
          <Pillar icon="target" title="A lottery that can't lose you money">
            The prize pool is funded entirely by staking yield, so nobody's principal is ever at risk.
            Stakers collect free tickets and the jackpot pays out in ICP.
          </Pillar>
          <Pillar icon="list" title="Proposal discussions">
            Start a conversation on any proposal, weigh in with comments, and up/down-vote the takes.
            Conversation-starters earn lottery tickets as their take gets upvoted, and ICP spent here is
            burned 100% — so the community debate itself tightens supply.
          </Pillar>
          <Pillar icon="spark" title="X-Farm">
            Spin up your own Farmer canister that burns ICP into cycles and drafts fresh, grounded
            pro-ICP tweets — each ending with $ICP — for you to review and post. Proof-of-burn that
            doubles as outreach.
          </Pillar>
        </div>
      </div>

      {/* ── Vision ── */}
      <div className="col" style={{ gap: 10 }}>
        <Eyebrow accent>Where we're headed</Eyebrow>
        <div style={{ ...card, gap: 12, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 8%, var(--surface))' }}>
          <p style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.6, margin: 0 }}>
            Our vision is a self-sustaining, deflationary commons on the IC — one where the community's
            combined neurons are a force in NNS governance, and where the value created flows back to the
            people who show up.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            <li>Grow the Neuron Syndicate until the community leader is a top-tier voice on every proposal that matters.</li>
            <li>Drive a steady, transparent burn so participation measurably tightens ICP supply over time.</li>
            <li>Recycle protocol yield into prizes, payouts, and community R&D — funding public goods the ecosystem needs.</li>
            <li>Make the lottery prize <b>sustainable and genuinely valuable</b> — growing the jackpot as ICP reaches key price targets, so a win means more over time, not less.</li>
            <li>Keep every value-moving path on-chain, auditable, and lossless by design.</li>
          </ul>
        </div>
      </div>

      {/* ── A call to ICP builders ── */}
      <div className="col" style={{ gap: 10 }}>
        <Eyebrow accent>A call to ICP builders</Eyebrow>
        <div style={{ ...card, gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.6, margin: 0 }}>
            If you're building on the Internet Computer, <b style={{ color: 'var(--fg)' }}>join me in this mission</b>.
            The IC wins when its builders stop fighting over the same small pie and start growing it together.
            Let's <b>band together</b>: cross-promote each other's dapps, integrate and actually <i>use</i> one another's
            tools, and send users across the ecosystem instead of walling them in.
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, margin: 0 }}>
            Infighting and fragmentation are the only things that can hold the IC back — so let's choose the
            opposite. Lift each other up, point your community at great ICP apps, and make the Internet Computer
            the obvious home for the next wave of users. A rising tide carries every canister.
          </p>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Btn variant="secondary" onClick={() => go('explorer')}>
              <Icon name="compass" size={13} /> Discover ICP dapps
            </Btn>
            <Btn variant="ghost" onClick={() => go('ideas')}>
              <Icon name="bulb" size={13} /> Pitch on Roadmap &amp; Development
            </Btn>
          </div>
        </div>
      </div>

      {/* ── CTA ── */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {!signedIn ? (
          <Btn variant="primary" onClick={onSignIn}>Sign in with Internet Identity</Btn>
        ) : (
          <Btn variant="primary" onClick={() => go('voting')}>
            <Icon name="flame" size={14} stroke="var(--char-950)" /> Start steering the NNS
          </Btn>
        )}
        <Btn variant="secondary" onClick={() => go('earn')}>
          <Icon name="coins" size={13} /> Join the Neuron Syndicate
        </Btn>
      </div>
    </div>
  );
}
