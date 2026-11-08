// Human-readable names for districts (H3 res-7 parents) so queues don't show raw hex ids.
// Fictional worlds (Harbor Bend) get made-up neighborhood names; real geography gets
// neutral "District N" labels so we never invent names over real places.
import { cellToParent, getResolution } from 'h3-js';

const PREFIX = [
  'Seawall', 'Pelican', 'Oyster', 'Heron', 'Cypress', 'Magnolia', 'Bayou', 'Marsh', 'Saltgrass',
  'Driftwood', 'Live Oak', 'Tidewater', 'Gulfview', 'Harbor', 'Pecan', 'Lighthouse', 'Egret',
  'Sandpiper', 'Palmetto', 'Cedar', 'Willow', 'Redfish', 'Shell', 'Mesquite', 'Bluewater',
];
const SUFFIX = ['Point', 'Flats', 'Heights', 'Row', 'Landing', 'Shores', 'Park', 'Village', 'Hill', 'Bend'];

export interface Labeler {
  district: (hex: string) => string;   // name of the res-7 district containing a res-8 hex (or the district itself)
  cell: (hex: string) => string;       // "<district> · <n>" for a res-8 cell
}

export function makeLabeler(hexes: readonly string[], fictional: boolean): Labeler {
  const parents = [...new Set(hexes.map((h) => cellToParent(h, 7)))].sort();
  const nameOf = new Map<string, string>();
  parents.forEach((p, i) => {
    if (fictional) {
      const k = (i * 7) % (PREFIX.length * SUFFIX.length);
      nameOf.set(p, `${PREFIX[k % PREFIX.length]} ${SUFFIX[Math.floor(k / PREFIX.length) % SUFFIX.length]}`);
    } else {
      nameOf.set(p, `District ${i + 1}`);
    }
  });
  const kidsOf = new Map<string, string[]>();
  for (const h of [...hexes].sort()) {
    const p = cellToParent(h, 7);
    const list = kidsOf.get(p);
    if (list) list.push(h);
    else kidsOf.set(p, [h]);
  }
  const parentOf = (hex: string) => (getResolution(hex) <= 7 ? hex : cellToParent(hex, 7));
  return {
    district: (hex) => nameOf.get(parentOf(hex)) ?? 'Unknown area',
    cell: (hex) => {
      const p = parentOf(hex);
      const idx = (kidsOf.get(p) ?? []).indexOf(hex);
      return `${nameOf.get(p) ?? 'Unknown area'}${idx >= 0 ? ` · ${idx + 1}` : ''}`;
    },
  };
}
