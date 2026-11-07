// Loads A's data/live.json and data/model.json if they exist in the repo,
// otherwise falls back to the in-browser mock. The globs resolve at dev-server
// start, so restart `npm run dev` after A commits new data files.
import type { EventBundle, ModelParams } from '@shared/types';
import { generateMockBundle } from './mockBundle';

const liveFiles = import.meta.glob<EventBundle>('../../../data/live.json', { import: 'default' });
const modelFiles = import.meta.glob<ModelParams>('../../../data/model.json', { import: 'default' });

export interface LoadedData {
  bundle: EventBundle;
  model: ModelParams | null;
  source: 'live.json' | 'mock';
}

export async function loadData(): Promise<LoadedData> {
  const liveLoader = Object.values(liveFiles)[0];
  const modelLoader = Object.values(modelFiles)[0];
  const model = modelLoader ? await modelLoader() : null;
  if (liveLoader) return { bundle: await liveLoader(), model, source: 'live.json' };
  return { bundle: generateMockBundle(), model, source: 'mock' };
}
