/**
 * Context for canvas-iframe UI (context menus, popovers).
 *
 * React still executes in the parent window when the canvas is mounted via
 * `createRoot` inside the iframe, so `document` is the parent document.
 * `container` is the iframe body — used to find the iframe element and map
 * pointer coordinates into parent space. Overlay UI (context menus) should
 * portal to the parent `document.body` so it is not clipped by the iframe,
 * which is sized to the component in component-edit mode.
 */
import { createContext, useContext } from 'react';

interface CanvasPortalValue {
  container: HTMLElement | null;
  /** Canvas zoom percentage (100 = 100%) */
  zoom: number;
}

const CanvasPortalContext = createContext<CanvasPortalValue>({
  container: null,
  zoom: 100,
});

export const CanvasPortalProvider = CanvasPortalContext.Provider;

/** Returns the iframe body element when inside the canvas, or null otherwise */
export function useCanvasPortalContainer(): HTMLElement | null {
  return useContext(CanvasPortalContext).container;
}

/** Returns the canvas zoom percentage (100 = 100%) when inside the canvas */
export function useCanvasZoom(): number {
  return useContext(CanvasPortalContext).zoom;
}

interface RemappablePointerEvent {
  clientX: number;
  clientY: number;
  nativeEvent?: { clientX: number; clientY: number };
}

function overwriteClientCoords(target: object, x: number, y: number): void {
  try {
    Object.defineProperty(target, 'clientX', { configurable: true, get: () => x });
    Object.defineProperty(target, 'clientY', { configurable: true, get: () => y });
  } catch {
    // Some browsers expose clientX/Y as non-configurable getters.
  }
}

/**
 * Rewrites an iframe pointer event's client coordinates into the parent
 * viewport. Radix context menus read `clientX`/`clientY` to place a virtual
 * anchor; when the menu is portaled to the parent document those values must
 * already be in parent space (and scaled to match `transform: scale()` zoom).
 */
export function remapIframePointerEventToParent(
  event: RemappablePointerEvent,
  iframeBody: HTMLElement,
  zoom: number
): void {
  const frame = iframeBody.ownerDocument.defaultView?.frameElement;
  if (!(frame instanceof HTMLElement)) return;

  const rect = frame.getBoundingClientRect();
  const scale = zoom / 100;
  const x = rect.left + event.clientX * scale;
  const y = rect.top + event.clientY * scale;

  overwriteClientCoords(event, x, y);
  if (event.nativeEvent) {
    overwriteClientCoords(event.nativeEvent, x, y);
  }
}
