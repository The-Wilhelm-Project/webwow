'use client';

import React from 'react';

/**
 * Icons the rail needs that `components/ui/icon.tsx` does not have.
 * 24 px viewBox, stroked with currentColor; rendered at `size-4` like the other rail icons.
 */
export type RailIconName =
  | 'pin'
  | 'pin-filled'
  | 'help-circle'
  | 'apps'
  | 'sign-out'
  | 'panel-collapse'
  | 'user'
  | 'keyboard'
  | 'sun'
  | 'moon'
  | 'monitor';

const PATHS: Record<RailIconName, React.ReactNode> = {
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
    </>
  ),
  'pin-filled': (
    <>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" fill="currentColor" />
    </>
  ),
  'help-circle': (
    <>
      <circle
        cx="12" cy="12"
        r="9"
      />
      <path d="M9.6 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1 .9-1 1.5v.3" />
      <path d="M12 17h.01" />
    </>
  ),
  apps: (
    <>
      <rect
        x="3" y="3"
        width="7" height="7"
        rx="1.5"
      />
      <rect
        x="14" y="3"
        width="7" height="7"
        rx="1.5"
      />
      <rect
        x="3" y="14"
        width="7" height="7"
        rx="1.5"
      />
      <rect
        x="14" y="14"
        width="7" height="7"
        rx="1.5"
      />
    </>
  ),
  'sign-out': (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  'panel-collapse': (
    <>
      <rect
        x="3" y="4"
        width="18" height="16"
        rx="2"
      />
      <path d="M9 4v16" />
      <path d="M15 10l-2 2 2 2" />
    </>
  ),
  user: (
    <>
      <circle
        cx="12" cy="8"
        r="4"
      />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  keyboard: (
    <>
      <rect
        x="2" y="6"
        width="20" height="12"
        rx="2"
      />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
    </>
  ),
  sun: (
    <>
      <circle
        cx="12" cy="12"
        r="4"
      />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect
        x="3" y="4"
        width="18" height="12"
        rx="2"
      />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
};

export const RAIL_ICON_NAMES = Object.keys(PATHS) as RailIconName[];

export function isRailIconName(name: string): name is RailIconName {
  return name in PATHS;
}

export interface RailIconProps extends React.SVGProps<SVGSVGElement> {
  name: RailIconName;
}

export const RailIcon = React.memo(function RailIcon({ name, ...svgProps }: RailIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...svgProps}
    >
      {PATHS[name]}
    </svg>
  );
});

export default RailIcon;
