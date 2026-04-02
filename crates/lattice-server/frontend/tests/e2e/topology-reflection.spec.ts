import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

interface ExpectedSnapshot {
  devices: Array<{ label: string }>;
  links: Array<{ local_label: string; remote_label: string }>;
}

interface ReflectionRules {
  focus_labels: string[];
  root_label: string;
  scenario: string;
}

const expectedSnapshotPath = process.env.TOPOLOGY_REFLECTION_EXPECTED_SNAPSHOT_PATH;
const rulesPath = process.env.TOPOLOGY_REFLECTION_RULES_PATH;
const screenshotPath = process.env.TOPOLOGY_REFLECTION_SCREENSHOT_PATH;

test.skip(
  !expectedSnapshotPath || !rulesPath || !screenshotPath,
  'Topology reflection assertions only run in the dedicated workflow.'
);

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

test('live topology data is reflected in the UI', async ({ page }) => {
  const expectedSnapshot = await readJsonFile<ExpectedSnapshot>(expectedSnapshotPath!);
  const rules = await readJsonFile<ReflectionRules>(rulesPath!);

  await page.goto('/');
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => Boolean(window.__latticeViewer));

  await expect
    .poll(async () => {
      return page.evaluate(() => window.__latticeViewer?.getState().discoveryState ?? null);
    })
    .toBe('ready');

  const reflectionState = await page.evaluate((labels) => {
    const viewer = window.__latticeViewer;
    if (!viewer) {
      return null;
    }

    const state = viewer.getState();
    const deviceById = new Map(state.snapshot.devices.map((device) => [device.id, device]));
    const sceneLabels = Array.from(state.model.sceneDeviceIds)
      .map((deviceId) => deviceById.get(deviceId)?.label ?? deviceId)
      .sort((left, right) => left.localeCompare(right));

    const points = Object.fromEntries(
      labels.map((label) => {
        const device = state.snapshot.devices.find((candidate) => candidate.label === label);
        return [label, device ? viewer.screenPointForDevice(device.id) : null];
      })
    );

    return {
      bodyText: document.body.textContent ?? '',
      deviceCount: state.deviceCount,
      sceneLabels,
      visibleLinkCount: state.visibleLinkCount,
      points,
    };
  }, rules.focus_labels);

  expect(reflectionState).not.toBeNull();
  if (!reflectionState) {
    throw new Error('Topology reflection state was not available.');
  }

  expect(reflectionState.deviceCount).toBe(expectedSnapshot.devices.length);
  expect(reflectionState.visibleLinkCount).toBe(expectedSnapshot.links.length);
  expect(reflectionState.sceneLabels).toContain(rules.root_label);

  for (const label of rules.focus_labels) {
    expect(reflectionState.bodyText).toContain(label);
    expect(reflectionState.sceneLabels).toContain(label);
    expect(reflectionState.points[label]).not.toBeNull();
  }

  await page.screenshot({
    fullPage: true,
    path: screenshotPath!,
  });
});
