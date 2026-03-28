import { readFile } from 'node:fs/promises';

import type { ViewSnapshot } from '../../src/model/view-snapshot';

export async function loadViewSnapshotFixture(
  name: 'empty' | 'populated'
): Promise<ViewSnapshot> {
  const fixtureUrl = new URL(`../fixtures/${name}.json`, import.meta.url);
  const raw = await readFile(fixtureUrl, 'utf8');

  return JSON.parse(raw) as ViewSnapshot;
}
