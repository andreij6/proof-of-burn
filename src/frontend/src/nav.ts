import { useCallback, useEffect, useRef, useState } from 'react';

// ==========================================================================
// Hash-driven sub-screen routing for hub pages.
//
// A hub page (Lottery, Arcade, Casino) shows a landing grid plus several
// sub-screens. Keeping the active sub-screen in local React state makes the
// browser/device Back button useless inside the hub — Back skips straight out
// of the page because the sub-screen was never a history entry. Instead the
// active screen lives in the URL after the page path, e.g.
//
//     #/arcade            → the hub ("lobby")
//     #/arcade/course-play → a sub-screen
//
// so every screen transition is a real history entry and Back returns to the
// previous screen. App.pageFromHash() resolves any `#/<page>/<sub>` back to its
// hub page, so the top-level router stays put while the sub-screen changes.
// (Casino pioneered this pattern; this hook generalises it.)
// ==========================================================================

/**
 * @param pagePath the hub's top-level path, e.g. '/lottery' or '/arcade'
 * @param hub      the screen value for the hub itself (rendered at `#<pagePath>`
 *                 with no trailing segment)
 * @returns `[screen, setScreen]` — `setScreen` pushes a history entry so Back
 *          pops it; the value also tracks browser Back/Forward via `hashchange`.
 */
export function useHashScreen<T extends string>(
  pagePath: string,
  hub: T,
): [T, (s: T) => void] {
  const read = useCallback((): T => {
    const h = (typeof window !== 'undefined' ? window.location.hash : '').replace(/^#\/?/, '');
    const seg = h.split('/').slice(1).join('/'); // everything after the page path
    return (seg || hub) as T;
  }, [hub]);

  const [screen, setScreenState] = useState<T>(read);

  const setScreen = useCallback((s: T) => {
    setScreenState(s);
    if (typeof window === 'undefined') return;
    const target = s === hub ? `#${pagePath}` : `#${pagePath}/${s}`;
    // Assigning location.hash pushes a history entry (unlike replaceState).
    if (window.location.hash !== target) window.location.hash = target;
  }, [pagePath, hub]);

  // Track Back/Forward (and any external hash change) without re-subscribing.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    const onHash = () => setScreenState(readRef.current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return [screen, setScreen];
}
