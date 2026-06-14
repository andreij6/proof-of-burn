import { useEffect } from "react";
import { getAnalytics, isSupported, logEvent, type Analytics } from "firebase/analytics";
import { app } from "./firebase";

// ==========================================================================
// Firebase Analytics for a hash-routed single-page app.
//
// Two things GA4 does not do for us automatically here:
//   1. page_view — the SPA never reloads, so navigation between in-app pages
//      and hub sub-screens (which all live in window.location.hash; see
//      nav.ts / App.pageFromHash) emits no page_view. We fire one on every
//      hashchange.
//   2. button clicks — we want an event for every click with descriptive
//      properties. Rather than wire every <button>/Btn call site, a single
//      capture-phase delegated listener catches them all and derives a label
//      from the button's text / aria-label, plus the current screen and any
//      data-evt-* attributes as extra properties.
// ==========================================================================

let analytics: Analytics | null = null;
let ready = false;
// Events fired before isSupported() resolves are buffered, then flushed.
const queue: Array<[string, Record<string, unknown>]> = [];

isSupported().then((supported) => {
  if (!supported) return; // SSR / unsupported browser / no measurementId
  analytics = getAnalytics(app);
  ready = true;
  for (const [name, params] of queue) logEvent(analytics, name, params);
  queue.length = 0;
  trackScreen(); // initial landing screen
});

/** Log an event now, or buffer it until Analytics is ready. */
export function track(name: string, params: Record<string, unknown> = {}) {
  if (ready && analytics) logEvent(analytics, name, params);
  else queue.push([name, params]);
}

/**
 * Record that the user was shown an error, with the message in the properties.
 * `context` names where it surfaced (e.g. 'withdraw', 'vote_commit').
 */
export function trackError(message: unknown, context = "") {
  track("error_shown", {
    // GA4 caps string param values at 100 chars; keep some headroom.
    message: String(message ?? "").slice(0, 200),
    context,
    screen: screenName(),
  });
}

/**
 * Fire an `error_shown` impression when `error` transitions to a truthy value
 * — i.e. when the error actually renders. Call once per error state, e.g.
 *   useErrorImpression(withdrawError, 'withdraw');
 */
export function useErrorImpression(error: string | null | undefined, context: string) {
  useEffect(() => {
    if (error) trackError(error, context);
  }, [error, context]);
}

/** Current screen from the hash, e.g. '' → 'landing', '/arcade/course-play'. */
function screenName(): string {
  const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#\/?/, "");
  return h === "" ? "landing" : h;
}

/** Fire a page_view for the screen named by the current hash. */
export function trackScreen() {
  if (typeof window === "undefined") return;
  const screen = screenName();
  track("page_view", {
    page_path: "/" + screen.replace(/^landing$/, ""),
    page_location: window.location.href,
    page_title: document.title,
    screen,
  });
}

if (typeof window !== "undefined") {
  // Screen changes: covers top-level pages and hub sub-screens alike.
  window.addEventListener("hashchange", trackScreen);

  // Every alert() in this app is an error/failure message shown to the user,
  // so capture it centrally rather than editing each call site. The native
  // alert still runs exactly as before.
  const nativeAlert = window.alert.bind(window);
  window.alert = (message?: string) => {
    trackError(message, "alert");
    nativeAlert(message as string);
  };

  // Every button click. Capture phase so we still see clicks whose handlers
  // call stopPropagation(). Disabled buttons emit no click event, so they are
  // naturally excluded.
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        'button, [role="button"]'
      ) as HTMLElement | null;
      if (!el) return;
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("data-evt") ||
        (el.textContent || "").trim().slice(0, 80) ||
        "button";
      const params: Record<string, unknown> = { label, screen: screenName() };
      // data-evt-foo="bar" → { foo: "bar" } for descriptive, per-button props.
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith("data-evt-")) {
          params[attr.name.slice("data-evt-".length)] = attr.value;
        }
      }
      track("click", params);
    },
    true
  );
}
