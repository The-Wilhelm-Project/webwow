import { notFound } from 'next/navigation';
import DevCssControlsClient from './ui/dev-css-controls-client';

/**
 * Webwow-only: developer sandbox for the design control panels.
 *
 * Renders SpacingControls / TypographyControls / EffectControls against a dummy
 * layer so the panels can be styled without booting the builder and without a
 * database. Carried over from the pre-rebuild fork (app/dev/css-controls).
 * Dev-only: in a production build the route 404s.
 */
export default function DevCssControlsPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return <DevCssControlsClient />;
}
