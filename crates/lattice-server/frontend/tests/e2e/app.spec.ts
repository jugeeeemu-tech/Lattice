import { expect, test, type Page, type TestInfo } from '@playwright/test';

import type { ViewSnapshot } from '../../src/generated';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

const VARIANT_FIXTURE_DEVICES = [
  { deviceId: 'variant-router', variant: 'router' },
  { deviceId: 'variant-switch', variant: 'switch' },
  { deviceId: 'variant-bridge', variant: 'bridge' },
  { deviceId: 'variant-server', variant: 'server' },
  { deviceId: 'variant-container', variant: 'container' },
  { deviceId: 'variant-unknown', variant: 'unknown' },
] as const;

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
  let nextDiscoveryResponse: 'busy' | 'started' = 'started';

  await page.route('**/api/topology', async (route) => {
    await route.fulfill({
      body: JSON.stringify(currentSnapshotRef.value),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.route('**/api/discover', async (route) => {
    discoverCount += 1;
    if (nextDiscoveryResponse === 'busy') {
      nextDiscoveryResponse = 'started';
      await route.fulfill({
        body: JSON.stringify({ status: 'busy' }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
      discovery_status: {
        state: 'discovering',
        message: null,
      },
      next_auto_discovery_at_ms: null,
    });

    await route.fulfill({
      body: JSON.stringify({
        status: 'started',
        snapshot: currentSnapshotRef.value,
      }),
      contentType: 'application/json',
      status: 202,
    });
  });

  return {
    getDiscoverCount: () => discoverCount,
    setNextDiscoveryResponse: (response: 'busy' | 'started') => {
      nextDiscoveryResponse = response;
    },
  };
}

async function waitForViewer(page: Page) {
  await page.waitForFunction(() => Boolean(window.__latticeViewer));
  await page.waitForSelector('canvas');
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
    if (!(control instanceof HTMLButtonElement)) {
      return null;
    }

    const progress = Number.parseFloat(
      control.style.getPropertyValue('--ring-progress') || '0'
    );

    return {
      ariaLabel: control.ariaLabel,
      progress,
      state: control.dataset.discoveryState ?? '',
    };
  });
}

async function discoveryGlyphScale(page: Page) {
  return page.evaluate(() => {
    const glyph = document.querySelector('[data-role="discovery-control"] .icon-button__glyph');
    if (!(glyph instanceof HTMLElement)) {
      return null;
    }

    const transform = getComputedStyle(glyph).transform;
    if (transform === 'none') {
      return 1;
    }

    return Number(new DOMMatrixReadOnly(transform).a.toFixed(2));
  });
}

async function discoveryButtonOffsetY(page: Page) {
  return page.evaluate(() => {
    const button = document.querySelector('[data-role="discovery-control"]');
    if (!(button instanceof HTMLElement)) {
      return null;
    }

    const transform = getComputedStyle(button).transform;
    if (transform === 'none') {
      return 0;
    }

    return Number(new DOMMatrixReadOnly(transform).m42.toFixed(2));
  });
}

async function firstTreeIconMetrics(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('.tree-row__mark svg');
    const path = document.querySelector('.tree-row__mark svg path');
    if (!(svg instanceof SVGSVGElement) || !(path instanceof SVGPathElement)) {
      return null;
    }

    const pathBox = path.getBBox();
    const svgBox = svg.getBoundingClientRect();
    const styles = getComputedStyle(path);

    return {
      fill: styles.fill,
      pathBBoxHeight: pathBox.height,
      pathBBoxWidth: pathBox.width,
      pathNamespace: path.namespaceURI,
      stroke: styles.stroke,
      svgHeight: svgBox.height,
      svgWidth: svgBox.width,
      svgNamespace: svg.namespaceURI,
    };
  });
}

function filterSnapshotToDevices(
  snapshot: ViewSnapshot,
  deviceIds: readonly string[]
): ViewSnapshot {
  const allowedDeviceIds = new Set(deviceIds);
  const treeRows = snapshot.tree_rows.filter((row) => allowedDeviceIds.has(row.device_id));
  const allowedRowIds = new Set(treeRows.map((row) => row.id));

  return {
    ...snapshot,
    devices: snapshot.devices.filter((device) => allowedDeviceIds.has(device.id)),
    links: snapshot.links.filter(
      (link) =>
        allowedDeviceIds.has(link.local_device_id) && allowedDeviceIds.has(link.remote_device_id)
    ),
    tree_rows: treeRows,
    tree_edges: snapshot.tree_edges.filter(
      (edge) => allowedRowIds.has(edge.parent_row_id) && allowedRowIds.has(edge.child_row_id)
    ),
    primary_row_by_device: Object.fromEntries(
      Object.entries(snapshot.primary_row_by_device).filter(
        ([deviceId, rowId]) => allowedDeviceIds.has(deviceId) && allowedRowIds.has(rowId)
      )
    ),
  };
}

async function pushMockSnapshot(page: Page, snapshot: ViewSnapshot) {
  return page.evaluate((payload) => {
    return (
      window as Window & { __latticeSocketTest?: { send: (frame: unknown) => boolean } }
    ).__latticeSocketTest?.send(payload);
  }, snapshot);
}

async function captureArtifactScreenshot(
  page: Page,
  testInfo: TestInfo,
  fileName: string
): Promise<string> {
  const path = testInfo.outputPath(fileName);
  await page.screenshot({
    fullPage: true,
    path,
  });
  await testInfo.attach(fileName, {
    path,
    contentType: 'image/png',
  });
  return path;
}

async function sceneDeviceCount(page: Page) {
  return page.evaluate(() => window.__latticeViewer?.getState().model.sceneDeviceIds.size ?? 0);
}

async function treeIconVariants(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tree-row__mark')).map(
      (element) => (element as HTMLElement).dataset.variant ?? ''
    )
  );
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
    const app = document.querySelector('#app');
    const viewport = document.querySelector('.viewport');
    const scene = document.querySelector('#scene-host');
    const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
    const canvas = document.querySelector('canvas');
    if (
      !(app instanceof HTMLElement) ||
      !(viewport instanceof HTMLElement) ||
      !(scene instanceof HTMLElement) ||
      !(sidebar instanceof HTMLElement) ||
      !(canvas instanceof HTMLCanvasElement)
    ) {
      return null;
    }

    const appRect = app.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const sceneRect = scene.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const gl =
      canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ??
      canvas.getContext('webgl', { preserveDrawingBuffer: true });
    const clearColor = gl ? (gl.getParameter(gl.COLOR_CLEAR_VALUE) as [number, number, number, number]) : null;

    return {
      appRect: {
        bottom: appRect.bottom,
        height: appRect.height,
        left: appRect.left,
        right: appRect.right,
        top: appRect.top,
        width: appRect.width,
      },
      canvasBackgroundColor: getComputedStyle(canvas).backgroundColor,
      canvasClearAlpha: clearColor ? Number(clearColor[3].toFixed(2)) : null,
      canvasRect: {
        bottom: canvasRect.bottom,
        height: canvasRect.height,
        left: canvasRect.left,
        right: canvasRect.right,
        top: canvasRect.top,
        width: canvasRect.width,
      },
      hasReloadButton: Array.from(document.querySelectorAll('button')).some((button) =>
        (button.textContent ?? '').includes('再読込')
      ),
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      sceneRect: {
        bottom: sceneRect.bottom,
        height: sceneRect.height,
        left: sceneRect.left,
        right: sceneRect.right,
        top: sceneRect.top,
        width: sceneRect.width,
      },
      scrollHeight: document.documentElement.scrollHeight,
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
      sidebarInsideViewport:
        sidebarRect.left >= viewportRect.left &&
        sidebarRect.top >= viewportRect.top &&
        sidebarRect.right <= viewportRect.right &&
        sidebarRect.bottom <= viewportRect.bottom,
      sidebarRightGap: viewportRect.right - sidebarRect.right,
      viewportBackgroundImage: getComputedStyle(viewport).backgroundImage,
      viewportBorderTopWidth: getComputedStyle(viewport).borderTopWidth,
      viewportBoxShadow: getComputedStyle(viewport).boxShadow,
      viewportRadius: getComputedStyle(viewport).borderRadius,
      viewportRect: {
        bottom: viewportRect.bottom,
        height: viewportRect.height,
        left: viewportRect.left,
        right: viewportRect.right,
        top: viewportRect.top,
        width: viewportRect.width,
      },
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics?.innerWidth).toBe(metrics?.appRect.width);
  expect(metrics?.scrollHeight).toBe(metrics?.innerHeight);
  expect(metrics?.appRect.left).toBe(0);
  expect(metrics?.appRect.top).toBe(0);
  expect(metrics?.viewportRect.left).toBe(0);
  expect(metrics?.viewportRect.top).toBe(0);
  expect(metrics?.sceneRect.left).toBe(0);
  expect(metrics?.sceneRect.top).toBe(0);
  expect(metrics?.canvasRect.left).toBe(0);
  expect(metrics?.canvasRect.top).toBe(0);
  expect(metrics?.viewportRect.width).toBe(metrics?.innerWidth);
  expect(metrics?.viewportRect.height).toBe(metrics?.innerHeight);
  expect(metrics?.sceneRect.width).toBe(metrics?.innerWidth);
  expect(metrics?.sceneRect.height).toBe(metrics?.innerHeight);
  expect(metrics?.canvasRect.width).toBe(metrics?.innerWidth);
  expect(metrics?.canvasRect.height).toBe(metrics?.innerHeight);
  expect(metrics?.sidebarInsideViewport).toBe(true);
  expect(metrics?.sidebarBackground).toBe('rgb(255, 255, 255)');
  expect(metrics?.canvasBackgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(metrics?.canvasClearAlpha).toBe(0);
  expect(metrics?.sidebarRightGap ?? 0).toBeGreaterThan(48);
  expect(metrics?.hasReloadButton).toBe(false);
  expect(metrics?.viewportBorderTopWidth).toBe('0px');
  expect(metrics?.viewportBoxShadow).toBe('none');
  expect(metrics?.viewportBackgroundImage).toBe('none');
  expect(metrics?.viewportRadius).toBe('0px');
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
  const hoverPlacement = await page.evaluate(() => {
    const viewer = window.__latticeViewer;
    const hoverCardElement = document.querySelector('[data-role="hover-card"]');
    const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
    const viewport = document.querySelector('.viewport');
    const anchor = viewer?.screenAnchorForDevice('guest-app') ?? null;
    if (
      !(hoverCardElement instanceof HTMLElement) ||
      !(sidebar instanceof HTMLElement) ||
      !(viewport instanceof HTMLElement) ||
      !anchor
    ) {
      return null;
    }

    const hoverRect = hoverCardElement.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();

    return {
      anchorVisibility: anchor.visibility,
      hoverLeft: hoverRect.left,
      hoverTop: hoverRect.top,
      sidebarRight: sidebarRect.right,
      viewportBottom: viewportRect.bottom,
      viewportTop: viewportRect.top,
    };
  });
  expect(hoverPlacement).not.toBeNull();
  expect(hoverPlacement?.anchorVisibility).toBe('visible');
  expect(hoverPlacement?.hoverLeft ?? 0).toBeGreaterThan((hoverPlacement?.sidebarRight ?? 0) + 8);
  expect(hoverPlacement?.hoverTop ?? 0).toBeGreaterThan(hoverPlacement?.viewportTop ?? 0);
  expect(hoverPlacement?.hoverTop ?? 0).toBeLessThan(hoverPlacement?.viewportBottom ?? Infinity);
  await page.locator('.tree').dispatchEvent('pointerleave');
  await expect(hoverCard).toBeHidden();

  await clickSceneDevice(page, 'router-core');
  await expect(page.locator('[data-device-id="router-core"].is-selected')).toBeVisible();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe('router-core');
});

test('centers the scene between the free area and the full viewport using a 6:4 weighting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewer = window.__latticeViewer;
        if (!viewer) {
          return 0;
        }

        return Array.from(viewer.getState().model.sceneDeviceIds).filter(
          (deviceId) => viewer.screenPointForDevice(deviceId) !== null
        ).length;
      })
    )
    .toBeGreaterThan(0);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewer = window.__latticeViewer;
        const viewport = document.querySelector('.viewport');
        const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
        if (!viewer || !(viewport instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
          return null;
        }

        const deviceIds = Array.from(viewer.getState().model.sceneDeviceIds);
        const points = deviceIds
          .map((deviceId) => viewer.screenPointForDevice(deviceId))
          .filter((point): point is { x: number; y: number } => Boolean(point));
        if (points.length === 0) {
          return null;
        }

        const average = points.reduce(
          (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
          { x: 0, y: 0 }
        );
        const viewportRect = viewport.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();

        return {
          averageScreenX: average.x / points.length,
          freeAreaCenterX: ((sidebarRect.right - viewportRect.left) + viewportRect.width) / 2,
          viewportCenterX: viewportRect.width / 2,
          weightedCenterX:
            ((((sidebarRect.right - viewportRect.left) + viewportRect.width) / 2) * 0.6) +
            (viewportRect.width / 2) * 0.4,
        };
      })
    )
    .not.toBeNull();

  const resolvedMetrics = await page.evaluate(() => {
    const viewer = window.__latticeViewer;
    const viewport = document.querySelector('.viewport');
    const sidebar = document.querySelector('[data-role="sidebar-overlay"]');
    if (!viewer || !(viewport instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
      return null;
    }

    const deviceIds = Array.from(viewer.getState().model.sceneDeviceIds);
    const points = deviceIds
      .map((deviceId) => viewer.screenPointForDevice(deviceId))
      .filter((point): point is { x: number; y: number } => Boolean(point));
    if (points.length === 0) {
      return null;
    }

    const average = points.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 }
    );
    const viewportRect = viewport.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();

    return {
      averageScreenX: average.x / points.length,
      freeAreaCenterX: ((sidebarRect.right - viewportRect.left) + viewportRect.width) / 2,
      viewportCenterX: viewportRect.width / 2,
      weightedCenterX:
        ((((sidebarRect.right - viewportRect.left) + viewportRect.width) / 2) * 0.6) +
        (viewportRect.width / 2) * 0.4,
    };
  });

  expect(resolvedMetrics).not.toBeNull();
  const metrics = resolvedMetrics as {
    averageScreenX: number;
    freeAreaCenterX: number;
    viewportCenterX: number;
    weightedCenterX: number;
  };
  expect(
    Math.abs(metrics.averageScreenX - metrics.weightedCenterX)
  ).toBeLessThan(80);
  expect(metrics.averageScreenX).toBeGreaterThan(metrics.viewportCenterX);
  expect(metrics.averageScreenX).toBeLessThan(metrics.freeAreaCenterX);
  expect(Math.abs(metrics.averageScreenX - metrics.weightedCenterX)).toBeLessThan(
    Math.abs(metrics.averageScreenX - metrics.freeAreaCenterX)
  );
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
  await page.locator('[data-role="discovery-action"]').hover();
  await expect.poll(() => discoveryButtonOffsetY(page)).toBe(0);
  await expect(page.locator('[data-role="discovery-tooltip"]')).toContainText('今すぐ再探索');
  await expect(page.locator('[data-role="discovery-tooltip"]')).toContainText('最新の構成を取得します。');
  await expect(page.locator('[data-role="discovery-tooltip"]')).not.toContainText(
    '60秒ごとに自動で更新します。'
  );

  await discoveryControl.dispatchEvent('pointerdown', {
    button: 0,
    clientX: 0,
    clientY: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
  });
  await expect.poll(() => discoveryGlyphScale(page)).toBe(0.9);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      })
    );
  });
  await expect.poll(() => discoveryGlyphScale(page)).toBe(1);

  await discoveryControl.click();
  expect(api.getDiscoverCount()).toBe(1);
  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('discovering');
  await expect(discoveryControl).toBeDisabled();

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
  await expect(discoveryControl).toBeEnabled();
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
  await page.locator('[data-role="discovery-action"]').hover();
  await expect(page.locator('[data-role="discovery-tooltip"]')).toContainText('SNMP timeout');
});

test('accepts manual refresh clicks on the outer progress ring hit area', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  const api = await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const bounds = await page.locator('[data-role="discovery-control"]').boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) {
    return;
  }

  await page.mouse.click(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2);

  await expect.poll(() => api.getDiscoverCount()).toBe(1);
  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('discovering');
});

test('supports keyboard activation with Enter and Space', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  const api = await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const discoveryControl = page.locator('[data-role="discovery-control"]');
  await discoveryControl.focus();
  await page.keyboard.press('Enter');

  await expect.poll(() => api.getDiscoverCount()).toBe(1);
  await expect(discoveryControl).toBeDisabled();

  currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
    discovery_status: {
      state: 'ready',
      message: null,
    },
    next_auto_discovery_at_ms: Date.now() + 60_000,
  });
  await expect.poll(() => pushMockSnapshot(page, currentSnapshotRef.value)).toBe(true);

  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('ready');
  await expect(discoveryControl).toBeEnabled();
  await discoveryControl.focus();
  await page.keyboard.press('Space');

  await expect.poll(() => api.getDiscoverCount()).toBe(2);
  await expect(discoveryControl).toBeDisabled();
});

test('does not update the current snapshot when manual refresh returns busy', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  const api = await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const before = await page.evaluate(() => ({
    discoveryState: window.__latticeViewer?.getState().discoveryState ?? null,
    nextAutoDiscoveryAtMs: window.__latticeViewer?.getState().nextAutoDiscoveryAtMs ?? null,
  }));

  api.setNextDiscoveryResponse('busy');
  await page.locator('[data-role="discovery-control"]').click();

  await expect.poll(() => api.getDiscoverCount()).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        discoveryState: window.__latticeViewer?.getState().discoveryState ?? null,
        nextAutoDiscoveryAtMs: window.__latticeViewer?.getState().nextAutoDiscoveryAtMs ?? null,
      }))
    )
    .toEqual(before);
});

test('shows explanatory tooltips for device and link counts', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await page.locator('[data-role="device-stat"]').hover();
  const deviceTooltipStyles = await page.evaluate(() => {
    const tooltip = document.querySelector('[data-role="device-stat-tooltip"]');
    if (!(tooltip instanceof HTMLElement)) {
      return null;
    }
    const styles = getComputedStyle(tooltip);
    return {
      opacity: styles.opacity,
      transform: styles.transform,
      transitionDuration: styles.transitionDuration,
    };
  });
  expect(deviceTooltipStyles).toEqual({
    opacity: '1',
    transform: 'none',
    transitionDuration: '0s',
  });
  await expect(page.locator('[data-role="device-stat-tooltip"]')).toContainText('表示中の機器数');
  await expect(page.locator('[data-role="device-stat-tooltip"]')).toContainText(
    '3Dシーンと構成ツリーに含まれる機器の数です。'
  );

  await page.locator('[data-role="link-stat"]').hover();
  await expect(page.locator('[data-role="link-stat-tooltip"]')).toContainText('表示中のリンク数');
  await expect(page.locator('[data-role="link-stat-tooltip"]')).toContainText(
    '現在表示している接続の数です。'
  );
});

test('renders sidebar device icons as visible SVG paths', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  const metrics = await firstTreeIconMetrics(page);
  expect(metrics).not.toBeNull();
  expect(metrics?.svgNamespace).toBe('http://www.w3.org/2000/svg');
  expect(metrics?.pathNamespace).toBe('http://www.w3.org/2000/svg');
  expect(metrics?.svgWidth ?? 0).toBeGreaterThan(10);
  expect(metrics?.svgHeight ?? 0).toBeGreaterThan(10);
  expect(metrics?.pathBBoxWidth ?? 0).toBeGreaterThan(4);
  expect(metrics?.pathBBoxHeight ?? 0).toBeGreaterThan(2);
  expect(metrics?.fill).not.toBe('none');
  expect(metrics?.stroke).not.toBe('none');
});

test('captures overview and focused comparison screenshots for all visual variants', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installTestHooks(page);
  const baseSnapshot = scheduledSnapshot(await loadViewSnapshotFixture('all-variants'));
  const currentSnapshotRef = {
    value: baseSnapshot,
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await expect(page.locator('.tree-row')).toHaveCount(VARIANT_FIXTURE_DEVICES.length);
  await expect.poll(() => sceneDeviceCount(page)).toBe(VARIANT_FIXTURE_DEVICES.length);

  const overviewVariants = new Set(await treeIconVariants(page));
  expect(overviewVariants).toEqual(
    new Set(VARIANT_FIXTURE_DEVICES.map((device) => device.variant))
  );

  await captureArtifactScreenshot(page, testInfo, 'all-variants-overview.png');

  for (const { deviceId, variant } of VARIANT_FIXTURE_DEVICES) {
    currentSnapshotRef.value = scheduledSnapshot(filterSnapshotToDevices(baseSnapshot, [deviceId]));
    await pushMockSnapshot(page, currentSnapshotRef.value);

    await expect(page.locator('.tree-row')).toHaveCount(1);
    await expect.poll(() => sceneDeviceCount(page)).toBe(1);
    await expect
      .poll(async () => {
        const variants = await treeIconVariants(page);
        return variants[0] ?? null;
      })
      .toBe(variant);

    await captureArtifactScreenshot(page, testInfo, `variant-${variant}-focused.png`);
  }
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
