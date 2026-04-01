import { readFile } from 'node:fs/promises';

import type { ViewSnapshot } from '../../src/generated';
import { decodeViewSnapshot } from '../../src/topology/decode-view-snapshot';

export async function loadViewSnapshotFixture(
  name: 'all-variants' | 'empty' | 'populated'
): Promise<ViewSnapshot> {
  const fixtureUrl = new URL(`../fixtures/${name}.json`, import.meta.url);
  const raw = await readFile(fixtureUrl, 'utf8');

  return decodeViewSnapshot(JSON.parse(raw));
}
