import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTxFlow } from '../TxModal';

// The staged transaction controller behind every money flow's modal. The
// stage-derivation (done/active/pending/error) and terminal states are the
// load-bearing logic — a wrong "current" index or a lost error message would
// mislead the user mid-transaction.
describe('useTxFlow', () => {
  it('starts idle and closed', () => {
    const { result } = renderHook(() => useTxFlow());
    expect(result.current.state.kind).toBe('idle');
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isActive).toBe(false);
  });

  it('start() opens the modal with the first stage active, the rest pending', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['Transferring', 'Finalizing'], { title: 'Staking' }));
    const s = result.current.state;
    expect(s.kind).toBe('running');
    if (s.kind !== 'running') throw new Error('unreachable');
    expect(s.title).toBe('Staking');
    expect(s.current).toBe(0);
    expect(s.stages.map((x) => x.status)).toEqual(['active', 'pending']);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.isActive).toBe(true);
  });

  it('next() advances: earlier stages done, current active, later pending', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['A', 'B', 'C']));
    act(() => result.current.next('step 2'));
    let s = result.current.state;
    if (s.kind !== 'running') throw new Error('unreachable');
    expect(s.current).toBe(1);
    expect(s.detail).toBe('step 2');
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'active', 'pending']);
    // next() past the last stage clamps to the last index.
    act(() => result.current.next());
    act(() => result.current.next());
    s = result.current.state;
    if (s.kind !== 'running') throw new Error('unreachable');
    expect(s.current).toBe(2);
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'done', 'active']);
  });

  it('setStage() jumps to an explicit index', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['A', 'B', 'C']));
    act(() => result.current.setStage(2));
    const s = result.current.state;
    if (s.kind !== 'running') throw new Error('unreachable');
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'done', 'active']);
  });

  it('succeed() marks every stage done and closes the busy state', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['A', 'B']));
    act(() => result.current.succeed('All set.'));
    const s = result.current.state;
    expect(s.kind).toBe('success');
    if (s.kind !== 'success') throw new Error('unreachable');
    expect(s.detail).toBe('All set.');
    expect(s.stages.every((x) => x.status === 'done')).toBe(true);
    expect(result.current.isActive).toBe(false);
    expect(result.current.isOpen).toBe(true); // stays open to show the result
  });

  it('fail() errors the active stage and surfaces the friendly message', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['A', 'B', 'C']));
    act(() => result.current.next());
    act(() => result.current.fail('Not enough balance to cover the fee.'));
    const s = result.current.state;
    expect(s.kind).toBe('error');
    if (s.kind !== 'error') throw new Error('unreachable');
    expect(s.message).toBe('Not enough balance to cover the fee.');
    // Stage 1 (the one in flight) shows the error; earlier is done, later pending.
    expect(s.stages.map((x) => x.status)).toEqual(['done', 'error', 'pending']);
    expect(result.current.isActive).toBe(false);
  });

  it('reset() returns to idle/closed', () => {
    const { result } = renderHook(() => useTxFlow());
    act(() => result.current.start(['A']));
    act(() => result.current.reset());
    expect(result.current.state.kind).toBe('idle');
    expect(result.current.isOpen).toBe(false);
  });
});
