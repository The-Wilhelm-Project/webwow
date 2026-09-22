/**
 * Schedule a callback to run when the browser is idle, so it does not block
 * the current interaction. Falls back to setTimeout in environments without
 * requestIdleCallback (Safari, SSR) and to a sync call on the server.
 */
export function scheduleIdle(callback: () => void): void {
  if (typeof window === 'undefined') {
    callback();
    return;
  }
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(callback, { timeout: 1000 });
  } else {
    setTimeout(callback, 0);
  }
}
