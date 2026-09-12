'use client';

/**
 * Map Settings Component
 *
 * Settings panel for map layers.
 * Supports multiple providers (Mapbox, Google Map) with shared
 * location/zoom/marker settings and provider-specific style/behavior.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import ColorPicker from './ColorPicker';
import SettingsPanel from './SettingsPanel';

import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  DEFAULT_MAP_SETTINGS,
  MAP_PROVIDER_OPTIONS,
  getStyleOptions,
  getProviderConfig,
} from '@/lib/map-utils';
import { useDebounce } from '@/hooks/use-debounce';
import type { Layer, MapSettings as MapSettingsType, MapProvider, MapProviderSettings } from '@/types';

type SearchResult = { place_name: string; center: [number, number] };

const ZOOM_MIN = 1;
const ZOOM_MAX_MAPBOX = 22;
const ZOOM_MAX_GOOGLE = 21;
const ZOOM_STEP_MAPBOX = 0.1;
const ZOOM_STEP_GOOGLE = 1;

interface MapSettingsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
}

export default function MapSettings({ layer, onLayerUpdate }: MapSettingsProps) {
  const [isOpen, setIsOpen] = useState(true);
  const mapSettings = useMemo(
    () => ({
      ...DEFAULT_MAP_SETTINGS,
      ...layer?.settings?.map,
      mapbox: { ...DEFAULT_MAP_SETTINGS.mapbox, ...layer?.settings?.map?.mapbox },
      google: { ...DEFAULT_MAP_SETTINGS.google, ...layer?.settings?.map?.google },
    }),
    [layer?.settings?.map]
  );

  const provider = mapSettings.provider;
  const providerSettings = mapSettings[provider];
  const providerConfig = getProviderConfig(provider);
  const hasToken = !!useSettingsStore((s) => s.getSettingByKey(providerConfig.tokenSettingKey));

  const zoomMax = provider === 'google' ? ZOOM_MAX_GOOGLE : ZOOM_MAX_MAPBOX;
  const zoomStep = provider === 'google' ? ZOOM_STEP_GOOGLE : ZOOM_STEP_MAPBOX;

  // Local input state for lat/lng/zoom to allow free typing
  const [latInput, setLatInput] = useState(String(mapSettings.latitude));
  const [lngInput, setLngInput] = useState(String(mapSettings.longitude));
  const [zoomInput, setZoomInput] = useState(String(mapSettings.zoom));

  const [addressQuery, setAddressQuery] = useState(mapSettings.search || '');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAddressFocused, setIsAddressFocused] = useState(false);
  const debouncedQuery = useDebounce(addressQuery, 400);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Sync local inputs when layer selection changes
  useEffect(() => {
    setLatInput(String(mapSettings.latitude));
    setLngInput(String(mapSettings.longitude));
    setZoomInput(String(mapSettings.zoom));
    setAddressQuery(mapSettings.search || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.id]);

  const updateMapSettings = useCallback(
    (updates: Partial<MapSettingsType>) => {
      if (!layer) return;

      onLayerUpdate(layer.id, {
        settings: {
          ...layer.settings,
          map: {
            ...mapSettings,
            ...updates,
          },
        },
      });
    },
    [layer, mapSettings, onLayerUpdate]
  );

  /** Update a field inside the active provider's nested settings */
  const updateProviderSettings = useCallback(
    (updates: Partial<MapProviderSettings>) => {
      updateMapSettings({
        [provider]: { ...providerSettings, ...updates },
      });
    },
    [provider, providerSettings, updateMapSettings]
  );

  const debouncedUpdateRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debouncedUpdateMapSettings = useCallback(
    (updates: Partial<MapSettingsType>) => {
      clearTimeout(debouncedUpdateRef.current);
      debouncedUpdateRef.current = setTimeout(() => updateMapSettings(updates), 300);
    },
    [updateMapSettings]
  );
  useEffect(() => () => clearTimeout(debouncedUpdateRef.current), []);

  const handleLatChange = useCallback(
    (value: string) => {
      setLatInput(value);
      const num = parseFloat(value);
      if (!isNaN(num) && num >= -90 && num <= 90) {
        debouncedUpdateMapSettings({ latitude: num });
      }
    },
    [debouncedUpdateMapSettings]
  );

  const handleLngChange = useCallback(
    (value: string) => {
      setLngInput(value);
      const num = parseFloat(value);
      if (!isNaN(num) && num >= -180 && num <= 180) {
        debouncedUpdateMapSettings({ longitude: num });
      }
    },
    [debouncedUpdateMapSettings]
  );

  const handleZoomChange = useCallback(
    (value: string) => {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        const clamped = Math.max(ZOOM_MIN, Math.min(zoomMax, num));
        setZoomInput(String(clamped));
        debouncedUpdateMapSettings({ zoom: clamped });
      }
    },
    [debouncedUpdateMapSettings, zoomMax]
  );

  const handleSliderZoomChange = useCallback(
    (values: number[]) => {
      const zoom = values[0];
      setZoomInput(String(zoom));
      debouncedUpdateMapSettings({ zoom });
    },
    [debouncedUpdateMapSettings]
  );

  // Geocoding search via API route
  useEffect(() => {
    if (!hasToken || !debouncedQuery || debouncedQuery.length < 3) {
      setSearchResults([]);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setIsSearching(true);
    fetch(`/ycode/api/maps/geocode?q=${encodeURIComponent(debouncedQuery)}&provider=${provider}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((json) => {
        if (json.data) {
          setSearchResults(json.data);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setSearchResults([]);
        }
      })
      .finally(() => setIsSearching(false));
  }, [debouncedQuery, provider, hasToken]);

  const handleSelectResult = useCallback(
    (result: SearchResult) => {
      const [lng, lat] = result.center;
      setLatInput(String(lat));
      setLngInput(String(lng));
      setAddressQuery(result.place_name);
      setSearchResults([]);
      updateMapSettings({ latitude: lat, longitude: lng, search: result.place_name });
    },
    [updateMapSettings]
  );

  if (!layer || layer.name !== 'map') {
    return null;
  }

  const styleOptions = getStyleOptions(provider);

  return (
    <SettingsPanel
      title="Map"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
    >
      <div className="flex flex-col gap-2.5">
        {/* Provider */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Provider</Label>
          <div className="col-span-2 flex items-center gap-1.5">
            <Select
              value={provider}
              onValueChange={(value: MapProvider) =>
                updateMapSettings({ provider: value })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAP_PROVIDER_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  size="sm"
                  variant={hasToken ? 'secondary' : 'default'}
                  className="shrink-0"
                >
                  <Link href={`/ycode/integrations/apps?type=maps&app=${providerConfig.appId}`}>
                    <Icon name="settings" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Set {providerConfig.label} API key</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Address search */}
        <Popover open={isAddressFocused && searchResults.length > 0}>
          <div className="grid grid-cols-3 items-start">
            <Label variant="muted" className="pt-2">Address</Label>
            <div className="col-span-2 relative">
              <PopoverAnchor asChild>
                <Input
                  value={addressQuery}
                  onChange={(e) => setAddressQuery(e.target.value)}
                  onFocus={() => setIsAddressFocused(true)}
                  onBlur={() => setTimeout(() => setIsAddressFocused(false), 150)}
                  placeholder="Search for an address..."
                />
              </PopoverAnchor>
              {isSearching && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  ...
                </div>
              )}
            </div>
          </div>
          <PopoverContent
            align="end"
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="w-auto max-w-none max-h-48 overflow-y-auto p-1 border-transparent"
          >
            {searchResults.map((result, i) => (
              <button
                key={i}
                className="flex w-full cursor-pointer items-center rounded-sm py-1.5 px-2 text-xs text-muted-foreground outline-hidden hover:bg-accent hover:text-accent-foreground truncate"
                onClick={() => handleSelectResult(result)}
              >
                {result.place_name}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        {/* Coordinates */}
        <div className="grid grid-cols-3 items-center">
          <div className="flex items-center gap-1.5">
            <Label variant="muted">Coord.</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Icon name="info" className="size-3 opacity-70" />
              </TooltipTrigger>
              <TooltipContent>Latitude / Longitude</TooltipContent>
            </Tooltip>
          </div>
          <div className="col-span-2 grid grid-cols-2 gap-2">
            <Input
              value={latInput}
              onChange={(e) => handleLatChange(e.target.value)}
              placeholder="40.7128"
            />
            <Input
              value={lngInput}
              onChange={(e) => handleLngChange(e.target.value)}
              placeholder="-74.0060"
            />
          </div>
        </div>

        {/* Zoom */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Zoom</Label>
          <div className="col-span-2 flex items-center gap-2">
            <Slider
              value={[parseFloat(zoomInput) || mapSettings.zoom]}
              min={ZOOM_MIN}
              max={zoomMax}
              step={zoomStep}
              onValueChange={handleSliderZoomChange}
              className="flex-1 min-w-0"
            />
            <div className="w-14 shrink-0">
              <Input
                stepper
                min={ZOOM_MIN}
                max={zoomMax}
                step={zoomStep}
                value={zoomInput}
                onChange={(e) => handleZoomChange(e.target.value)}
                className="pr-5!"
              />
            </div>
          </div>
        </div>

        {/* Style (provider-specific) */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Style</Label>
          <div className="col-span-2">
            <Select
              value={providerSettings.style}
              onValueChange={(value: string) =>
                updateProviderSettings({ style: value })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {styleOptions.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Marker (Mapbox only — Embed API uses default pin) */}
        {provider === 'mapbox' && (
          <div className="grid grid-cols-3 items-center gap-2">
            <Label variant="muted">Marker</Label>
            <div className="col-span-2 [&>div]:w-full [&>button]:w-full">
              <ColorPicker
                value={mapSettings.markerColor || ''}
                onChange={(value) => updateMapSettings({ markerColor: value || null })}
                onClear={() => updateMapSettings({ markerColor: null })}
                defaultValue="#2e79d6"
                placeholder="No marker"
                solidOnly
              />
            </div>
          </div>
        )}

        {/* Behavior (Mapbox only — Embed API controls interactivity) */}
        {provider === 'mapbox' && (
          <div className="grid grid-cols-3 items-start gap-2">
            <Label variant="muted">Behavior</Label>
            <div className="col-span-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="map-interactive"
                  checked={providerSettings.interactive}
                  onCheckedChange={(checked: boolean) =>
                    updateProviderSettings({ interactive: checked })
                  }
                />
                <Label
                  variant="muted"
                  htmlFor="map-interactive"
                  className="cursor-pointer"
                >
                  Interactive
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="map-scroll-zoom"
                  checked={providerSettings.scrollZoom}
                  disabled={!providerSettings.interactive}
                  onCheckedChange={(checked: boolean) =>
                    updateProviderSettings({ scrollZoom: checked })
                  }
                />
                <Label
                  variant="muted"
                  htmlFor="map-scroll-zoom"
                  className="cursor-pointer"
                >
                  Zoom with scroll
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="map-nav-control"
                  checked={providerSettings.showNavControl}
                  onCheckedChange={(checked: boolean) =>
                    updateProviderSettings({ showNavControl: checked })
                  }
                />
                <Label
                  variant="muted"
                  htmlFor="map-nav-control"
                  className="cursor-pointer"
                >
                  Navigation control
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="map-scale-bar"
                  checked={providerSettings.showScaleBar}
                  onCheckedChange={(checked: boolean) =>
                    updateProviderSettings({ showScaleBar: checked })
                  }
                />
                <Label
                  variant="muted"
                  htmlFor="map-scale-bar"
                  className="cursor-pointer"
                >
                  Scale bar
                </Label>
              </div>
            </div>
          </div>
        )}
      </div>
    </SettingsPanel>
  );
}
