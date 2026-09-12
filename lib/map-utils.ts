/**
 * Map Utilities
 *
 * Generates iframe props for map embeds.
 * - Mapbox: self-contained HTML via srcDoc (Mapbox GL JS)
 * - Google Maps: direct URL via src (Maps Embed API)
 */

import type { ColorVariable, GoogleMapStyle, MapProvider, MapProviderSettings, MapSettings, MapStyle } from '@/types';

// =============================================================================
// Provider config
// =============================================================================

const PROVIDER_CONFIG: Record<MapProvider, {
  tokenSettingKey: string;
  appId: string;
  label: string;
}> = {
  mapbox: { tokenSettingKey: 'mapbox_access_token', appId: 'mapbox', label: 'Mapbox' },
  google: { tokenSettingKey: 'google_maps_embed_api_key', appId: 'google-maps-embed', label: 'Google Map' },
};

export function getProviderConfig(provider: MapProvider) {
  return PROVIDER_CONFIG[provider];
}

export const MAP_PROVIDER_OPTIONS: { value: MapProvider; label: string }[] = [
  { value: 'google', label: 'Google Map' },
  { value: 'mapbox', label: 'Mapbox' },
];

// =============================================================================
// Mapbox
// =============================================================================

const MAPBOX_GL_VERSION = 'v3.20.0';
const MAPBOX_CDN_BASE = `https://cdn.jsdelivr.net/npm/mapbox-gl@${MAPBOX_GL_VERSION}/dist`;

const MAPBOX_STYLE_URLS: Record<MapStyle, string> = {
  streets: 'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  light: 'mapbox://styles/mapbox/light-v11',
  dark: 'mapbox://styles/mapbox/dark-v11',
  outdoors: 'mapbox://styles/mapbox/outdoors-v12',
};

export const MAPBOX_STYLE_OPTIONS: { value: MapStyle; label: string }[] = [
  { value: 'streets', label: 'Streets' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'outdoors', label: 'Outdoors' },
];

// =============================================================================
// Google Maps
// =============================================================================

export const GOOGLE_STYLE_OPTIONS: { value: GoogleMapStyle; label: string }[] = [
  { value: 'roadmap', label: 'Roadmap' },
  { value: 'satellite', label: 'Satellite' },
];

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_PROVIDER_SETTINGS: Record<MapProvider, MapProviderSettings> = {
  mapbox: {
    style: 'streets',
    interactive: true,
    scrollZoom: true,
    showNavControl: false,
    showScaleBar: false,
  },
  google: {
    style: 'roadmap',
    interactive: true,
    scrollZoom: true,
    showNavControl: false,
    showScaleBar: false,
  },
};

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  provider: 'mapbox',
  latitude: 40.712749,
  longitude: -74.005994,
  zoom: 12,
  markerColor: '#2e79d6',
  search: 'New York',
  mapbox: DEFAULT_PROVIDER_SETTINGS.mapbox,
  google: DEFAULT_PROVIDER_SETTINGS.google,
};

/** Get style options for the given provider */
export function getStyleOptions(provider: MapProvider) {
  return provider === 'google' ? GOOGLE_STYLE_OPTIONS : MAPBOX_STYLE_OPTIONS;
}

// =============================================================================
// Color variable resolution
// =============================================================================

/** Resolve a marker color value, looking up color variables when referenced */
export function resolveMarkerColor(
  markerColor: string | null,
  colorVariables: ColorVariable[],
): string | null {
  if (!markerColor) return null;
  const match = markerColor.match(/^color:var\(--([^)]+)\)$/);
  if (match) {
    const variable = colorVariables.find((v) => v.id === match[1]);
    return variable?.value || null;
  }
  return markerColor;
}

// =============================================================================
// Iframe props builders
// =============================================================================

export type MapIframeProps =
  | { type: 'srcDoc'; srcDoc: string }
  | { type: 'src'; src: string };

/** Build iframe props for the active provider */
export function getMapIframeProps(settings: MapSettings, token: string): MapIframeProps {
  if (settings.provider === 'google') {
    return { type: 'src', src: buildGoogleMapsEmbedUrl(settings, token) };
  }
  const ps = settings[settings.provider];
  return { type: 'srcDoc', srcDoc: buildMapboxEmbedHtml(settings, ps, token) };
}

const GOOGLE_EMBED_BASE = 'https://www.google.com/maps/embed/v1';

/** Build a Google Maps Embed API URL (uses `place` mode with a pin) */
function buildGoogleMapsEmbedUrl(settings: MapSettings, apiKey: string): string {
  const { latitude, longitude, zoom } = settings;
  const ps = settings.google;
  const maptype = (ps.style as GoogleMapStyle) || 'roadmap';

  const params = new URLSearchParams({
    key: apiKey,
    q: `${latitude},${longitude}`,
    zoom: String(Math.round(zoom)),
    maptype,
  });

  return `${GOOGLE_EMBED_BASE}/place?${params.toString()}`;
}

function buildMapboxEmbedHtml(
  settings: MapSettings,
  ps: MapProviderSettings,
  accessToken: string,
): string {
  const styleUrl = MAPBOX_STYLE_URLS[ps.style as MapStyle] || MAPBOX_STYLE_URLS.streets;
  const { latitude, longitude, zoom, markerColor } = settings;
  const { interactive, scrollZoom, showNavControl, showScaleBar } = ps;

  const disableHandlers: string[] = [];
  if (!interactive) {
    disableHandlers.push(
      'map.dragPan.disable();',
      'map.boxZoom.disable();',
      'map.doubleClickZoom.disable();',
      'map.touchZoomRotate.disable();',
      'map.keyboard.disable();',
    );
  }
  if (!interactive || !scrollZoom) {
    disableHandlers.push('map.scrollZoom.disable();');
  }

  const controls: string[] = [];
  if (showNavControl) controls.push('map.addControl(new mapboxgl.NavigationControl());');
  if (showScaleBar) controls.push('map.addControl(new mapboxgl.ScaleControl());');

  const markerScript = markerColor
    ? `new mapboxgl.Marker({color:'${markerColor.replace(/'/g, "\\'")}'}).setLngLat([${longitude}, ${latitude}]).addTo(map);`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="${MAPBOX_CDN_BASE}/mapbox-gl.css" rel="stylesheet">
<script src="${MAPBOX_CDN_BASE}/mapbox-gl.js"><${'/'}script>
<style>
  *{margin:0;padding:0}
  html,body,#map{width:100%;height:100%}
</style>
</head>
<body>
<div id="map"></div>
<script>
  mapboxgl.accessToken='${accessToken.replace(/'/g, "\\'")}';
  var map=new mapboxgl.Map({
    container:'map',
    style:'${styleUrl}',
    center:[${longitude},${latitude}],
    zoom:${zoom},
    attributionControl:true
  });
  ${disableHandlers.join('\n  ')}
  ${controls.join('\n  ')}
  ${markerScript}
<${'/'}script>
</body>
</html>`;
}
