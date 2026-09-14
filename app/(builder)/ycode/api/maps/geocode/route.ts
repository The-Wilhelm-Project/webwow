import { NextRequest, NextResponse } from 'next/server';
import { getMapboxAccessToken, getGoogleMapsEmbedApiKey } from '@/lib/map-server';
import type { MapProvider } from '@/types';

const MAPBOX_GEOCODING_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const GOOGLE_PLACES_URL = 'https://places.googleapis.com/v1';

interface GeoResult {
  place_name: string;
  center: [number, number];
}

async function geocodeMapbox(query: string): Promise<GeoResult[]> {
  const token = await getMapboxAccessToken();
  if (!token) throw new Error('Mapbox access token not configured');

  const url = `${MAPBOX_GEOCODING_URL}/${encodeURIComponent(query)}.json?access_token=${token}&limit=5&types=place,address,poi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding request failed');

  const data = await res.json();
  return (data.features || []).map((f: { place_name: string; center: [number, number] }) => ({
    place_name: f.place_name,
    center: f.center,
  }));
}

interface PlaceSuggestion {
  placePrediction?: {
    placeId: string;
    text: { text: string };
  };
}

interface PlaceDetails {
  location?: { latitude: number; longitude: number };
}

/** Uses Places API (New): autocomplete for suggestions, then Place Details for coordinates */
async function geocodeGoogle(query: string): Promise<GeoResult[]> {
  const key = await getGoogleMapsEmbedApiKey();
  if (!key) throw new Error('Google Map API key not configured');

  const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key };

  const autocompleteRes = await fetch(`${GOOGLE_PLACES_URL}/places:autocomplete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: query }),
  });
  if (!autocompleteRes.ok) {
    const err = await autocompleteRes.json().catch(() => ({}));
    throw new Error(`Places Autocomplete error: ${err.error?.message || autocompleteRes.statusText}`);
  }

  const { suggestions = [] } = await autocompleteRes.json() as { suggestions: PlaceSuggestion[] };
  const places = suggestions.filter((s) => s.placePrediction).slice(0, 5);
  if (places.length === 0) return [];

  const results = await Promise.all(
    places.map(async (s) => {
      const { placeId, text } = s.placePrediction!;
      const detailsRes = await fetch(
        `${GOOGLE_PLACES_URL}/places/${placeId}`,
        { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'location' } },
      );
      const details: PlaceDetails = await detailsRes.json();
      return {
        place_name: text.text,
        center: [details.location?.longitude ?? 0, details.location?.latitude ?? 0] as [number, number],
      };
    })
  );

  return results;
}

const GEOCODERS: Record<MapProvider, (query: string) => Promise<GeoResult[]>> = {
  mapbox: geocodeMapbox,
  google: geocodeGoogle,
};

/**
 * GET /ycode/api/maps/geocode?q=<search>&provider=<mapbox|google>
 *
 * Proxies geocoding requests to the active map provider's geocoding API.
 * Returns a normalized array of { place_name, center: [lng, lat] }.
 */
export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get('q');
    const provider = (request.nextUrl.searchParams.get('provider') || 'mapbox') as MapProvider;

    if (!query || query.length < 2) {
      return NextResponse.json(
        { error: 'Query must be at least 2 characters' },
        { status: 400 }
      );
    }

    const geocode = GEOCODERS[provider] || GEOCODERS.mapbox;
    const results = await geocode(query);

    return NextResponse.json({ data: results }, {
      headers: { 'Cache-Control': 'public, max-age=432000, s-maxage=432000' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to geocode address';

    // A missing provider token is an expected config state, not a server error
    const isNotConfigured = message.includes('not configured');
    if (!isNotConfigured) {
      console.error('Geocoding error:', error);
    }

    return NextResponse.json(
      { error: message },
      { status: isNotConfigured ? 400 : 500 }
    );
  }
}
