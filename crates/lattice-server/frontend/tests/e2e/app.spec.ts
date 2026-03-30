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
        const sockets = ((window as Window & { __latticeMockSockets?: MockWebSocket[] })
          .__latticeMockSockets ??= []);
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
      __latticeSocketTest: {
        close() {
          const sockets = (window as Window & { __latticeMockSockets?: MockWebSocket[] })
            .__latticeMockSockets ?? [];
          const socket = sockets.at(-1);
          if (!socket) {
            return false;
          }
          socket.close();
          return true;
        },
        send(snapshot: unknown) {
          const sockets = (window as Window & { __latticeMockSockets?: MockWebSocket[] })
            .__latticeMockSockets ?? [];
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

function scheduledSnapshot(
  snapshot: ViewSnapshot,
  overrides: Partial<ViewSnapshot> = {}
): ViewSnapshot {
  const { discovery_status, ...restOverrides } = overrides;
  const intervalSeconds = overrides.auto_discovery_interval_seconds ?? 60;
  return {
    ...snapshot,
    ...restOverrides,
    auto_discovery_interval_seconds: intervalSeconds,
    next_auto_discovery_at_ms:
      overrides.next_auto_discovery_at_ms ?? Date.now() + intervalSeconds * 1_000,
    discovery_status: {
      ...snapshot.discovery_status,
      ...discovery_status,
    },
  };
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
    currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
      discovery_status: {
        state: 'discovering',
        message: null,
      },
      next_auto_discovery_at_ms: null,
    });

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

async function discoveryControlMetrics(page: Page) {
  return page.evaluate(() => {
    const control = document.querySelector('[data-role="discovery-control"]');
    if (!(control instanceof HTMLElement)) {
      return null;
    }

    const progress = Number.parseFloat(
      control.style.getPropertyValue('--ring-progress') || '0'
    );

    return {
      ariaLabel:
        control.querySelector('button') instanceof HTMLButtonElement
          ? control.querySelector('button')?.ariaLabel ?? ''
          : '',
      progress,
      state: control.dataset.discoveryState ?? '',
    };
  });
}

test('fits into one screen and keeps the sidebar inside the viewport overlay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('empty'), {
      discovery_status: { state: 'loading', message: null },
      next_auto_discovery_at_ms: null,
    }),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await expect(page.getByText('Topology is warming up')).toBeVisible();
  await expect(
    page.getByText('初回探索が完了すると、3Dビューと構成が表示されます。')
  ).toBeVisible();

  const metrics = await page.evaluate(() => {
    const viewport = document.querySelector('.viewport');
    const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
    if (!(viewport instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
      return null;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();

    return {
      hasReloadButton: Array.from(document.querySelectorAll('button')).some((button) =>
        (button.textContent ?? '').includes('再読込')
      ),
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      sidebarInsideViewport:
        sidebarRect.left >= viewportRect.left &&
        sidebarRect.top >= viewportRect.top &&
        sidebarRect.right <= viewportRect.right &&
        sidebarRect.bottom <= viewportRect.bottom,
      sidebarRightGap: viewportRect.right - sidebarRect.right,
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics?.scrollHeight).toBe(metrics?.innerHeight);
  expect(metrics?.sidebarInsideViewport).toBe(true);
  expect(metrics?.sidebarRightGap ?? 0).toBeGreaterThan(48);
  expect(metrics?.hasReloadButton).toBe(false);
});

test('keeps tree and scene selection in sync inside the overlaid sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
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
    'Server · VM · Virtual · pve-01 上'
  );
  await page.locator('.tree').dispatchEvent('pointerleave');
  await expect(hoverCard).toBeHidden();

  await clickSceneDevice(page, 'router-core');
  await expect(page.locator('[data-device-id="router-core"].is-selected')).toBeVisible();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe('router-core');
});

test('uses the discovery icon for manual refresh, resets to busy state, and surfaces failures by tooltip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  const api = await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const discoveryControl = page.locator('[data-role="discovery-control"]');
  await page.locator('.floating-action--end').hover();
  await expect(page.locator('[data-role="discovery-tooltip"]')).toContainText('今すぐ再探索');

  await discoveryControl.locator('button').click();
  expect(api.getDiscoverCount()).toBe(1);
  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('discovering');

  currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
    discovery_status: {
      state: 'ready',
      message: null,
    },
    next_auto_discovery_at_ms: Date.now() + 60_000,
  });
  await page.evaluate((snapshot) => {
    return (
      window as Window & { __latticeSocketTest?: { send: (payload: unknown) => boolean } }
    ).__latticeSocketTest?.send(snapshot);
  }, currentSnapshotRef.value);

  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('ready');
  expect((await discoveryControlMetrics(page))?.progress ?? 0).toBeGreaterThan(0.95);

  currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
    discovery_status: {
      state: 'failed',
      message: 'SNMP timeout',
    },
    next_auto_discovery_at_ms: Date.now() + 45_000,
  });
  await page.evaluate((snapshot) => {
    return (
      window as Window & { __latticeSocketTest?: { send: (payload: unknown) => boolean } }
    ).__latticeSocketTest?.send(snapshot);
  }, currentSnapshotRef.value);

  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('failed');
  await page.locator('.floating-action--end').hover();
  await expect(page.locator('[data-role="discovery-tooltip"]')).toContainText('SNMP timeout');
});

test('switches the sidebar to a drawer on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const overlay = page.locator('[data-role="sidebar-overlay"]');
  const toggle = page.locator('[data-role="sidebar-toggle"]');

  await expect(toggle).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
        return sidebar instanceof HTMLElement ? Number.parseFloat(getComputedStyle(sidebar).opacity) : null;
      })
    )
    .toBe(0);

  await toggle.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
        return sidebar instanceof HTMLElement ? Number.parseFloat(getComputedStyle(sidebar).opacity) : null;
      })
    )
    .toBe(1);

  await overlay.locator('[data-device-id="guest-app"] .tree-row__label').click();
  await expect(page.locator('[data-device-id="guest-app"].is-selected')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
        return sidebar instanceof HTMLElement ? Number.parseFloat(getComputedStyle(sidebar).opacity) : null;
      })
    )
    .toBe(0);
});

test('preserves collapsed state across websocket and polling updates', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await page.locator('[data-entry-id="tree:seed:192.0.2.1/router-core#1"] .tree-toggle').click();
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);

  const websocketSnapshot = scheduledSnapshot(currentSnapshotRef.value, {
    next_auto_discovery_at_ms: Date.now() + 30_000,
  });
  await page.evaluate((snapshot) => {
    return (
      window as Window & { __latticeSocketTest?: { send: (payload: unknown) => boolean } }
    ).__latticeSocketTest?.send(snapshot);
  }, websocketSnapshot);
  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().nextAutoDiscoveryAtMs)
  ).resolves.toBe(websocketSnapshot.next_auto_discovery_at_ms);

  currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
    next_auto_discovery_at_ms: Date.now() + 15_000,
  });
  await page.evaluate(() => {
    return (
      window as Window & { __latticeSocketTest?: { close: () => boolean } }
    ).__latticeSocketTest?.close();
  });

  await expect(page.locator('[data-device-id="proxmox-host"]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__latticeViewer?.getState().nextAutoDiscoveryAtMs))
    .toBe(currentSnapshotRef.value.next_auto_discovery_at_ms);
});
