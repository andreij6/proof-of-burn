// Native BTC/ETH/ERC20 on/off-ramps via DFINITY's chain-key minters.
// Mainnet only — these canisters do not exist on a local replica.
//
// Deposits:
//   BTC   → ckBTC minter issues a per-principal BTC address; after the BTC
//           lands, update_balance mints ckBTC to the user.
//   ETH / USDC / USDT → the user calls the minter's Ethereum helper contract
//           with their principal encoded as bytes32; minting is automatic.
// Withdrawals:
//   ckBTC → retrieve_btc_with_approval (after icrc2_approve to the minter).
//   ckETH → withdraw_eth; ckERC20 → withdraw_erc20 (burns ckETH for gas, so
//           BOTH the token ledger and the ckETH ledger need approvals).
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";

export const CKBTC_MINTER_ID = "mqygn-kiaaa-aaaar-qaadq-cai";
export const CKETH_MINTER_ID = "sv3dd-oaaaa-aaaar-qacoa-cai";
export const CKETH_MINTER_DASHBOARD = `https://${CKETH_MINTER_ID}.raw.icp0.io/dashboard`;

/// The helper-contract argument: principal as bytes32 — first byte is the
/// principal's length, then the principal bytes, zero-padded to 32.
/// ⚠ Funds sent with a wrong encoding are LOST; the UI must surface the
/// minter dashboard's converter as the cross-check.
export function principalToBytes32(p: Principal): string {
  const bytes = p.toUint8Array();
  const out = new Uint8Array(32);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return '0x' + Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
}

const Account = IDL.Record({
  owner: IDL.Opt(IDL.Principal),
  subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
});

const ckbtcIdl: IDL.InterfaceFactory = ({ IDL: I }) =>
  I.Service({
    get_btc_address: I.Func([Account], [I.Text], []),
    update_balance: I.Func(
      [Account],
      [I.Variant({
        Ok: I.Vec(I.Variant({
          ValueTooSmall: I.Record({}), Tainted: I.Record({}),
          Checked: I.Record({}), Minted: I.Record({ minted_amount: I.Nat64, block_index: I.Nat64 }),
        })),
        Err: I.Variant({
          GenericError: I.Record({ error_message: I.Text, error_code: I.Nat64 }),
          TemporarilyUnavailable: I.Text,
          AlreadyProcessing: I.Null,
          NoNewUtxos: I.Record({}),
        }),
      })],
      [],
    ),
    retrieve_btc_with_approval: I.Func(
      [I.Record({ address: I.Text, amount: I.Nat64, from_subaccount: I.Opt(I.Vec(I.Nat8)) })],
      [I.Variant({
        Ok: I.Record({ block_index: I.Nat64 }),
        Err: I.Variant({
          MalformedAddress: I.Text,
          GenericError: I.Record({ error_message: I.Text, error_code: I.Nat64 }),
          TemporarilyUnavailable: I.Text,
          InsufficientAllowance: I.Record({ allowance: I.Nat64 }),
          AlreadyProcessing: I.Null,
          AmountTooLow: I.Nat64,
          InsufficientFunds: I.Record({ balance: I.Nat64 }),
        }),
      })],
      [],
    ),
  });

const ckethIdl: IDL.InterfaceFactory = ({ IDL: I }) =>
  I.Service({
    get_minter_info: I.Func(
      [],
      [I.Record({
        eth_helper_contract_address: I.Opt(I.Text),
        erc20_helper_contract_address: I.Opt(I.Text),
        deposit_with_subaccount_helper_contract_address: I.Opt(I.Text),
        minimum_withdrawal_amount: I.Opt(I.Nat),
      })],
      ['query'],
    ),
    withdraw_eth: I.Func(
      [I.Record({ recipient: I.Text, amount: I.Nat, from_subaccount: I.Opt(I.Vec(I.Nat8)) })],
      [I.Variant({
        Ok: I.Record({ block_index: I.Nat }),
        Err: I.Variant({
          RecipientAddressBlocked: I.Record({ address: I.Text }),
          TemporarilyUnavailable: I.Text,
          InsufficientAllowance: I.Record({ allowance: I.Nat }),
          AmountTooLow: I.Record({ min_withdrawal_amount: I.Nat }),
          InsufficientFunds: I.Record({ balance: I.Nat }),
        }),
      })],
      [],
    ),
    withdraw_erc20: I.Func(
      [I.Record({ ckerc20_ledger_id: I.Principal, recipient: I.Text, amount: I.Nat, from_ckerc20_subaccount: I.Opt(I.Vec(I.Nat8)), from_cketh_subaccount: I.Opt(I.Vec(I.Nat8)) })],
      [I.Variant({
        Ok: I.Record({ cketh_block_index: I.Nat, ckerc20_block_index: I.Nat }),
        Err: I.Variant({
          TokenNotSupported: I.Record({ supported_tokens: I.Vec(I.Record({ ckerc20_token_symbol: I.Text, ledger_canister_id: I.Principal, ckerc20_ledger_id: I.Opt(I.Principal) })) }),
          RecipientAddressBlocked: I.Record({ address: I.Text }),
          TemporarilyUnavailable: I.Text,
          CkEthLedgerError: I.Record({ error: I.Reserved }),
          CkErc20LedgerError: I.Record({ cketh_block_index: I.Nat, error: I.Reserved }),
          InsufficientAllowance: I.Record({ allowance: I.Nat, failed_burn_amount: I.Nat, token_symbol: I.Text, ledger_id: I.Opt(I.Principal) }),
          AmountTooLow: I.Record({ min_withdrawal_amount: I.Nat }),
          InsufficientFunds: I.Record({ balance: I.Nat, failed_burn_amount: I.Nat, token_symbol: I.Text, ledger_id: I.Opt(I.Principal) }),
        }),
      })],
      [],
    ),
    // ICRC-2 approve lives on the LEDGERS, not the minter — see approveIdl.
  });

const approveIdl: IDL.InterfaceFactory = ({ IDL: I }) =>
  I.Service({
    icrc2_approve: I.Func(
      [I.Record({
        from_subaccount: I.Opt(I.Vec(I.Nat8)),
        spender: I.Record({ owner: I.Principal, subaccount: I.Opt(I.Vec(I.Nat8)) }),
        amount: I.Nat,
        expected_allowance: I.Opt(I.Nat),
        expires_at: I.Opt(I.Nat64),
        fee: I.Opt(I.Nat),
        memo: I.Opt(I.Vec(I.Nat8)),
        created_at_time: I.Opt(I.Nat64),
      })],
      [I.Variant({ Ok: I.Nat, Err: I.Reserved })],
      [],
    ),
  });

interface AgentOpts { host: string; identity: unknown; rootKey?: Uint8Array }

function makeActor(idl: IDL.InterfaceFactory, canisterId: string, opts: AgentOpts) {
  const agent = HttpAgent.createSync({ host: opts.host, identity: opts.identity as never, rootKey: opts.rootKey });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor<any>(idl, { agent, canisterId });
}

export const makeCkbtcMinter = (opts: AgentOpts) => makeActor(ckbtcIdl, CKBTC_MINTER_ID, opts);
export const makeCkethMinter = (opts: AgentOpts) => makeActor(ckethIdl, CKETH_MINTER_ID, opts);
/// ICRC-2 approve on any ledger (used before minter withdrawals).
export const makeApprover = (ledgerId: string, opts: AgentOpts) => makeActor(approveIdl, ledgerId, opts);
