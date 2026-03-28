import { expect, test, type Page } from '@playwright/test';

import type { ViewSnapshot } from '../../src/model/view-snapshot';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

async function installTestHooks(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      url: string;

      constructor(url: string) {
        super();
        this.url = url;
        const sockets = ((window as Window & { __latticeMockSockets?: MockWebSocket[] }).__latticeMockSockets ??= []);
        sockets.push(this);

        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send() {}

      close() {
        if (this.readyState === MockWebSocket.CLOSED) {
          return;
        }
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }

    Object.assign(window, {
      WebSocket: MockWebSocket,
      __LATTICE_TEST_HOOKS: {
        reload: () => {
          (window as Window & { __latticeReloadCount?: number }).__latticeReloadCount =
            ((window as Window & { __latticeReloadCount?: number }).__latticeReloadCount ?? 0) + 1;
        },
      },
      __latticeSocketTest: {
        close() {
          const sockets = (window as Window & { __latticeMockSockets?: MockWebSocket[] }).__latticeMockSockets ?? [];
          const socket = sockets.at(-1);
          if (!socket) {
            return false;
          }
          socket.close();
          return true;
        },
        count() {
          return ((window as Window & { __latticeMockSockets?: MockWebSocket[] }).__latticeMockSockets ?? []).length;
        },
        send(snapshot: unknown) {
          const sockets = (window as Window & { __latticeMockSockets?: MockWebSocket[] }).__latticeMockSockets ?? [];
          const socket = sockets.at(-1);
          if (!socket) {
            return false;
          }
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify(snapshot),
            })
          );
          return true;
        },
      },
    });
  });
}

async function installApiRoutes(page: Page, currentSnapshotRef: { value: ViewSnapshot }) {
  let discoverCount = 0;

  await page.route('**/api/topology', async (route) => {
    await route.fulfill({
      body: JSON.stringify(currentSnapshotRef.value),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.route('**/api/discover', async (route) => {
    discoverCount += 1;
    await route.fulfill({
      body: JSON.stringify({ accepted: true }),
      contentType: 'application/json',
      status: 202,
    });
  });

  return {
    getDiscoverCount: () => discoverCount,
  };
}

async function waitForViewer(page: Page) {
  await page.waitForFunction(() => Boolean(window.__latticeViewer));
}

async function clickSceneDevice(page: Page, deviceId: string) {
  await page.waitForFunction(
    (targetDeviceId) => window.__latticeViewer?.screenPointForDevice(targetDeviceId) !== null,
    deviceId
  );

  const clicked = await page.evaluate((targetDeviceId) => {
    const point = window.__latticeViewer?.screenPointForDevice(targetDeviceId) ?? null;
    const canvas = document.querySelector('canvas');
    if (!point || !(canvas instanceof HTMLCanvasElement)) {
      return false;
    }

    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + point.x,
        clientY: rect.top + point.y,
      })
    );
    return true;
  }, deviceId);

  expect(clicked).toBe(true);
}

test('renders empty-state copy from the shared empty fixture', async ({ page }) => {
  await installTestHooks(page);
  const currentSnapshotRef = { value: await loadViewSnapshotFixture('empty') };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await expect(page.getByText('Topology is warming up')).toBeVisible();
  await expect(
    page.getByText('初回探索が完了すると、3D ビューと操作ペインが表示されます。')
  ).toBeVisible();
});

test('keeps tree and scene selection in sync and shows hover card details', async ({ page }) => {
  await installTestHooks(page);
  const currentSnapshotRef = { value: await loadViewSnapshotFixture('populated') };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await page.locator('[data-device-id="guest-app"] .tree-row__label').click();
  await expect(page.locator('[data-device-id="guest-app"].is-selected')).toBeVisible();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe('guest-app');

  await page.locator('[data-device-id="guest-app"] .tree-row__label').hover();
  const hoverCard = page.locator('[data-role="hover-card"]');
  await expect(hoverCard).toBeVisible();
  await expect(hoverCard.locator('[data-role="hover-title"]')).toHaveText('vm-app-01');
  await expect(hoverCard.locator('[data-role="hover-body"]')).toHaveText(
    'Server · Virtual · pve-01 上'
  );
  await page.locator('.tree').dispatchEvent('pointerleave');
  await expect(hoverCard).toBeHidden();

  await clickSceneDevice(page, 'router-core');
  await expect(page.locator('[data-device-id="router-core"].is-selected')).toBeVisible();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe('router-core');
});

test('uses label clicks for folder toggle plus selection while keeping toggle buttons collapse-only and rows compact', async ({
  page,
}) => {
  await installTestHooks(page);
  const currentSnapshotRef = { value: await loadViewSnapshotFixture('populated') };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const rootRow = page.locator('[data-entry-id="tree:seed:192.0.2.1/router-core#1"]');
  const rootLabel = rootRow.locator('.tree-row__label');
  const rootToggle = rootRow.locator('.tree-toggle');

  const openToggleGlyph = await rootToggle.evaluate((toggle) => {
    const before = getComputedStyle(toggle, '::before');
    const after = getComputedStyle(toggle, '::after');
    return {
      beforeWidth: Number.parseFloat(before.width),
      beforeHeight: Number.parseFloat(before.height),
      afterWidth: Number.parseFloat(after.width),
      afterHeight: Number.parseFloat(after.height),
      afterOpacity: Number.parseFloat(after.opacity),
    };
  });

  expect(openToggleGlyph.beforeWidth).toBeGreaterThan(openToggleGlyph.beforeHeight);
  expect(openToggleGlyph.afterHeight).toBeGreaterThan(openToggleGlyph.afterWidth);
  expect(openToggleGlyph.afterOpacity).toBe(0);

  const headerMetrics = await page.evaluate(() => {
    const panel = document.querySelector('.panel--info');
    const header = document.querySelector('.panel--info .panel__header');
    const tree = document.querySelector('.panel--info .tree');
    if (
      !(panel instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(tree instanceof HTMLElement)
    ) {
      return null;
    }

    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const treeRect = tree.getBoundingClientRect();
    return {
      gapBelowHeader: treeRect.top - headerRect.bottom,
      headerHeight: headerRect.height,
      gapAbovePanelBottom: panelRect.bottom - treeRect.bottom,
      panelHeight: panelRect.height,
      treeHeight: treeRect.height,
    };
  });

  expect(headerMetrics).not.toBeNull();
  expect(headerMetrics?.gapBelowHeader ?? Number.POSITIVE_INFINITY).toBeLessThan(20);
  expect(headerMetrics?.headerHeight ?? Number.POSITIVE_INFINITY).toBeLessThan(60);
  expect(headerMetrics?.gapAbovePanelBottom ?? Number.POSITIVE_INFINITY).toBeLessThan(24);
  expect(
    (headerMetrics?.treeHeight ?? 0) / Math.max(headerMetrics?.panelHeight ?? 1, 1)
  ).toBeGreaterThan(0.75);

  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedEntryId ?? null)
  ).resolves.toBeNull();

  await rootToggle.click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedEntryId ?? null)
  ).resolves.toBeNull();

  const closedToggleGlyph = await rootToggle.evaluate((toggle) => {
    const after = getComputedStyle(toggle, '::after');
    return {
      afterWidth: Number.parseFloat(after.width),
      afterHeight: Number.parseFloat(after.height),
    };
  });

  await expect(rootToggle).not.toHaveClass(/is-open/);
  expect(closedToggleGlyph.afterHeight).toBeGreaterThan(closedToggleGlyph.afterWidth);

  const collapsedMetrics = await page.evaluate(() => {
    const tree = document.querySelector('.tree');
    const row = document.querySelector('.tree-row');
    if (!(tree instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return null;
    }

    const treeRect = tree.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      rowHeight: rowRect.height,
      topOffset: rowRect.top - treeRect.top,
      treeHeight: treeRect.height,
    };
  });

  expect(collapsedMetrics).not.toBeNull();
  expect(collapsedMetrics?.topOffset ?? Number.POSITIVE_INFINITY).toBeLessThan(12);
  expect(collapsedMetrics?.rowHeight ?? Number.POSITIVE_INFINITY).toBeLessThan(80);
  expect(collapsedMetrics?.treeHeight ?? 0).toBeGreaterThan(collapsedMetrics?.rowHeight ?? 0);

  await rootToggle.click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(1);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedEntryId ?? null)
  ).resolves.toBeNull();

  await rootLabel.click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);
  await expect(rootRow).toHaveClass(/is-selected/);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedEntryId)
  ).resolves.toBe('tree:seed:192.0.2.1/router-core#1');

  await rootLabel.click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(1);
  await expect(rootRow).toHaveClass(/is-selected/);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedEntryId)
  ).resolves.toBe('tree:seed:192.0.2.1/router-core#1');
});

test('preserves collapsed state on websocket updates and falls back to polling when the socket closes', async ({
  page,
}) => {
  await installTestHooks(page);
  const currentSnapshotRef = { value: await loadViewSnapshotFixture('populated') };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await page.locator('[data-entry-id="tree:seed:192.0.2.1/router-core#1"] .tree-toggle').click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);

  const websocketSnapshot = {
    ...currentSnapshotRef.value,
    discovery_status: {
      state: 'ready',
      message: 'websocket snapshot loaded',
    },
  } satisfies ViewSnapshot;

  await page.evaluate((snapshot) => {
    return (window as Window & { __latticeSocketTest?: { send: (payload: unknown) => boolean } }).__latticeSocketTest?.send(snapshot);
  }, websocketSnapshot);
  await expect(page.getByText('websocket snapshot loaded')).toBeVisible();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);

  currentSnapshotRef.value = {
    ...currentSnapshotRef.value,
    discovery_status: {
      state: 'ready',
      message: 'polling snapshot loaded',
    },
  };
  await page.evaluate(() => {
    return (window as Window & { __latticeSocketTest?: { close: () => boolean } }).__latticeSocketTest?.close();
  });
  await expect(page.getByText('polling snapshot loaded')).toBeVisible({ timeout: 5000 });
});

test('keeps the rediscover and reload controls wired', async ({ page }) => {
  await installTestHooks(page);
  const currentSnapshotRef = { value: await loadViewSnapshotFixture('populated') };
  const api = await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  currentSnapshotRef.value = {
    ...currentSnapshotRef.value,
    discovery_status: {
      state: 'ready',
      message: 'discover refresh loaded',
    },
  };
  await page.getByRole('button', { name: '再探索' }).click();
  await expect(page.getByText('discover refresh loaded')).toBeVisible();
  expect(api.getDiscoverCount()).toBe(1);

  await page.getByRole('button', { name: '再読込' }).click();
  await expect(
    page.evaluate(() => (window as Window & { __latticeReloadCount?: number }).__latticeReloadCount ?? 0)
  ).resolves.toBe(1);
});
