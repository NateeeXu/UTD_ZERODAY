// Shared background map for every Leaflet view: a base layer plus a labels-only layer in its own pane,
// so place names draw above the data polygons.
//
// With VITE_HERE_API_KEY set (Production only) the tiles come from the HERE Raster Tile API v3
// (lite.day, the style HERE makes for data overlays). Without it, or if HERE tiles keep failing at
// runtime (bad key, quota, network), the map uses the keyless Esri Light Gray Canvas as before.
// Note: VITE_* values are inlined into the public bundle; restrict the key to the app's domains.
import L from 'leaflet';

export interface BasemapOptions {
  /** Pane for the labels layer; created if missing. Default 'labels'. */
  labelsPane?: string;
  /** z-index of the labels pane. Default 450: above overlayPane (400), below markers (600). */
  labelsZIndex?: number;
  /** Opacity of the labels layer. Default 1. */
  labelsOpacity?: number;
  /** Leaflet keepBuffer for both layers. Default: Leaflet's own (2). */
  keepBuffer?: number;
  /** Max map zoom the basemap supports. Default 16. */
  maxZoom?: number;
}

const HERE_KEY = ((import.meta.env.VITE_HERE_API_KEY as string | undefined) ?? '').trim();
const HERE = 'https://maps.hereapi.com/v3';
const HERE_STYLE = 'lite.day';
const HERE_TERMS = 'https://legal.here.com/en-gb/terms/general-content-supplier-terms-and-notices';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors';

// HERE tiles that fail before the map falls back to Esri: at least this many, and at least a third of
// all HERE tile results. Not just "before the first load": the CDN in front of HERE serves tiles it
// has cached even when the key is bad, so a bad key gives a patchy mix of loads and 401s.
const FALLBACK_MIN_ERRORS = 3;

/** Adds the basemap (base + labels layers) to `map`. Call once, right after creating the map. */
export function addBasemap(map: L.Map, opts: BasemapOptions = {}): void {
  const { labelsPane = 'labels', labelsZIndex = 450, labelsOpacity = 1, keepBuffer, maxZoom = 16 } = opts;
  const pane = map.getPane(labelsPane) ?? map.createPane(labelsPane);
  pane.style.zIndex = String(labelsZIndex);
  pane.style.pointerEvents = 'none';
  const common: L.TileLayerOptions = { maxZoom };
  if (keepBuffer !== undefined) common.keepBuffer = keepBuffer;
  const labels: L.TileLayerOptions = { ...common, pane: labelsPane, opacity: labelsOpacity };
  if (HERE_KEY) addHere(map, common, labels);
  else addEsri(map, common, labels);
}

function addEsri(map: L.Map, common: L.TileLayerOptions, labels: L.TileLayerOptions) {
  L.tileLayer(`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { ...common, attribution: ESRI_ATTRIBUTION }).addTo(map);
  L.tileLayer(`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, labels).addTo(map);
}

// A 512 px HERE tile at zoom z covers the same ground as the 256 px tile at z with twice the detail, so
// it equals four 256 tiles at z+1: a quarter of the requests at the same detail (zoomOffset -1).
// minZoom 1 keeps the URL zoom >= 0.
const hereUrl = (resource: 'background' | 'label', extra = '') =>
  `${HERE}/${resource}/mc/{z}/{x}/{y}/png8?style=${HERE_STYLE}&size=512${extra}&apiKey=${encodeURIComponent(HERE_KEY)}`;
const HERE_GRID: L.TileLayerOptions = { tileSize: 512, zoomOffset: -1, minZoom: 1 };

function addHere(map: L.Map, common: L.TileLayerOptions, labels: L.TileLayerOptions) {
  const base = L.tileLayer(hereUrl('background'), { ...common, ...HERE_GRID }).addTo(map);
  // POIs off: their icons include red pins, and red is reserved for priority areas.
  const text = L.tileLayer(hereUrl('label', '&features=pois:disabled'), { ...labels, ...HERE_GRID }).addTo(map);
  const credit = hereCredit(map);

  let loads = 0;
  let errors = 0;
  let fellBack = false;
  const onLoad = () => { loads++; };
  // Tiles still in flight can report errors after removal, hence the fellBack guard.
  const onError = () => {
    errors++;
    if (fellBack || errors < FALLBACK_MIN_ERRORS || errors * 2 < loads) return;
    fellBack = true;
    console.warn(`[basemap] HERE tiles failing (${errors} errors, ${loads} loaded); switching to Esri.`);
    base.off('tileload', onLoad).off('tileerror', onError);
    map.removeLayer(base);
    map.removeLayer(text);
    credit.remove();
    addEsri(map, common, labels);
  };
  base.on('tileload', onLoad).on('tileerror', onError);
}

// HERE's terms: "© <current year> HERE" plus the supplier labels (e.g. INEGI near Mexico) whose
// bounding boxes and zoom range cover the view, from the /copyright endpoint (refreshed every 24 h).
type Box = { west: number; south: number; east: number; north: number };
type CopyrightBlock = { label: string; minLevel: number; maxLevel: number; boundingBoxes?: Box[] | null };
type CopyrightResponse = {
  copyrights?: Record<string, CopyrightBlock[]>;
  resources?: Record<string, { styles?: Record<string, string[]> }>;
};

let copyrightCache: { at: number; blocks: Promise<CopyrightBlock[]> } | null = null;

function hereCopyrightBlocks(): Promise<CopyrightBlock[]> {
  if (!copyrightCache || Date.now() - copyrightCache.at > 86_400_000) {
    const blocks = fetch(`${HERE}/copyright?apiKey=${encodeURIComponent(HERE_KEY)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CopyrightResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const sources = new Set(['background', 'label'].flatMap((res) => j.resources?.[res]?.styles?.[HERE_STYLE] ?? []));
        return [...sources].flatMap((s) => j.copyrights?.[s] ?? []);
      });
    const entry = { at: Date.now(), blocks };
    copyrightCache = entry;
    blocks.catch(() => { if (copyrightCache === entry) copyrightCache = null; });
  }
  return copyrightCache.blocks;
}

function supplierLabels(blocks: CopyrightBlock[], view: L.LatLngBounds, zoom: number): string[] {
  const [s, w, n, e] = [view.getSouth(), view.getWest(), view.getNorth(), view.getEast()];
  const hit = (b: Box) => b.south <= n && b.north >= s && (b.west > b.east || (b.west <= e && b.east >= w));
  const out = blocks.filter((b) => zoom >= b.minLevel && zoom <= b.maxLevel && (!b.boundingBoxes?.length || b.boundingBoxes.some(hit)));
  return [...new Set(out.map((b) => b.label))];
}

function hereCredit(map: L.Map): { remove(): void } {
  const control = map.attributionControl;
  if (!control) return { remove() {} };
  const year = new Date().getFullYear();
  let shown = '';
  let blocks: CopyrightBlock[] = [];
  let live = true;
  // Only reads the view once blocks are loaded, which is after whenReady (the map has a view).
  const update = () => {
    const extra = blocks.length ? supplierLabels(blocks, map.getBounds(), Math.round(map.getZoom())) : [];
    const next = [`&copy; ${year} <a href="${HERE_TERMS}" target="_blank" rel="noopener">HERE</a>`, ...extra].join(', ');
    if (next === shown) return;
    if (shown) control.removeAttribution(shown);
    control.addAttribution(next);
    shown = next;
  };
  update();
  map.on('moveend', update);
  map.once('unload', () => { live = false; });
  hereCopyrightBlocks()
    .then((b) => {
      if (!live) return;
      blocks = b;
      map.whenReady(update);
    })
    .catch(() => { /* keep the plain "© year HERE" notice */ });
  return {
    remove() {
      live = false;
      map.off('moveend', update);
      if (shown) control.removeAttribution(shown);
      shown = '';
    },
  };
}
