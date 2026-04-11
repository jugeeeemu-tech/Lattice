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
        message: undefined,
      },
      next_auto_discovery_at_ms: undefined,
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

async function scenePointForDevice(page: Page, deviceId: string) {
  await page.waitForFunction(
    (targetDeviceId) => window.__latticeViewer?.screenPointForDevice(targetDeviceId) !== null,
    deviceId
  );

  const point = await page.evaluate((targetDeviceId) => {
    return window.__latticeViewer?.screenPointForDevice(targetDeviceId) ?? null;
  }, deviceId);

  expect(point).not.toBeNull();
  return point as { x: number; y: number };
}

async function clickSceneDevice(page: Page, deviceId: string) {
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

async function hoverSceneDevice(page: Page, deviceId: string) {
  const point = await scenePointForDevice(page, deviceId);
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move((bounds?.x ?? 0) + point.x, (bounds?.y ?? 0) + point.y);
}

async function dragSceneFromDevice(page: Page, deviceId: string, delta: { x: number; y: number }) {
  const point = await scenePointForDevice(page, deviceId);
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = (bounds?.x ?? 0) + point.x;
  const startY = (bounds?.y ?? 0) + point.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + delta.x, startY + delta.y, { steps: 8 });
  await page.mouse.up();
  return {
    clientX: startX + delta.x,
    clientY: startY + delta.y,
  };
}

async function beginSceneDragFromDevice(
  page: Page,
  deviceId: string,
  delta: { x: number; y: number }
) {
  const point = await scenePointForDevice(page, deviceId);
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = (bounds?.x ?? 0) + point.x;
  const startY = (bounds?.y ?? 0) + point.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + delta.x, startY + delta.y, { steps: 4 });
  return {
    clientX: startX + delta.x,
    clientY: startY + delta.y,
  };
}

async function endSceneDrag(page: Page) {
  await page.mouse.up();
}

async function dispatchSceneClick(page: Page, point: { clientX: number; clientY: number }) {
  await page.evaluate(({ clientX, clientY }) => {
    const canvas = document.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return false;
    }

    canvas.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      })
    );
    return true;
  }, point);
}

async function blankScenePoint(page: Page) {
  const point = await page.evaluate(() => {
    const viewer = window.__latticeViewer;
    const canvas = document.querySelector('canvas');
    if (!viewer || !(canvas instanceof HTMLCanvasElement)) {
      return null;
    }

    const state = viewer.getState();
    const devicePoints = Array.from(state.model.sceneDeviceIds)
      .map((deviceId) => viewer.screenPointForDevice(deviceId))
      .filter((candidate): candidate is { x: number; y: number } => Boolean(candidate));

    const margin = 96;
    const candidates = [
      { x: margin, y: margin },
      { x: canvas.clientWidth - margin, y: margin },
      { x: canvas.clientWidth - margin, y: canvas.clientHeight - margin },
      { x: margin, y: canvas.clientHeight - margin },
      { x: canvas.clientWidth * 0.75, y: canvas.clientHeight * 0.25 },
      { x: canvas.clientWidth * 0.75, y: canvas.clientHeight * 0.75 },
      { x: canvas.clientWidth * 0.6, y: canvas.clientHeight * 0.5 },
    ];

    let bestCandidate: { x: number; y: number } | null = null;
    let bestDistance = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const minDistance = devicePoints.reduce((currentMin, devicePoint) => {
        const distance = Math.hypot(candidate.x - devicePoint.x, candidate.y - devicePoint.y);
        return Math.min(currentMin, distance);
      }, Number.POSITIVE_INFINITY);

      if (minDistance > bestDistance) {
        bestDistance = minDistance;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  });

  expect(point).not.toBeNull();
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();

  return {
    clientX: (bounds?.x ?? 0) + (point?.x ?? 0),
    clientY: (bounds?.y ?? 0) + (point?.y ?? 0),
  };
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
      discovery_status: { state: 'loading', message: undefined },
      next_auto_discovery_at_ms: undefined,
    }),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await expect(page.getByText('構成を準備しています')).toBeVisible();
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
    'サーバー · VM · 仮想 · pve-01 上'
  );
  await expect(page.locator('.tree-row[data-device-id="guest-app"]')).toHaveClass(/is-hovered/);
  await expect(page.locator('.tree-row[data-device-id="router-core"]')).not.toHaveClass(
    /is-hovered/
  );
  await expect(page.locator('.tree-row[data-device-id="proxmox-host"]')).not.toHaveClass(
    /is-hovered/
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

test('selects a device from the full tree row hit area without highlighting ancestors', async ({
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

  await expect(
    page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree-row'));
      const pair = rows
        .map((row, index) => [row, rows[index + 1] ?? null] as const)
        .find(([upperRow, lowerRow]) => {
          if (!upperRow || !lowerRow) {
            return false;
          }

          const upperRect = upperRow.getBoundingClientRect();
          const lowerRect = lowerRow.getBoundingClientRect();
          return lowerRect.top > upperRect.bottom;
        });

      if (!pair) {
        return null;
      }

      const [upperRow, lowerRow] = pair;
      const upperRect = upperRow.getBoundingClientRect();
      const lowerRect = lowerRow.getBoundingClientRect();
      const sampleX = upperRect.left + 24;
      const sampleY = upperRect.bottom + (lowerRect.top - upperRect.bottom) / 2;
      const hit = document.elementFromPoint(sampleX, sampleY);
      return hit instanceof Element ? getComputedStyle(hit).cursor : null;
    })
  ).resolves.toBe('pointer');

  await page.locator('.tree-row[data-device-id="guest-app"]').click({
    position: { x: 6, y: 12 },
  });

  await expect(page.locator('[data-device-id="guest-app"].is-selected')).toBeVisible();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe('guest-app');
  await expect(page.locator('.tree-row[data-device-id="router-core"]')).not.toHaveClass(
    /is-ancestor/
  );
  await expect(page.locator('.tree-row[data-device-id="proxmox-host"]')).not.toHaveClass(
    /is-ancestor/
  );
});

test('scrolls the sidebar tree to a scene-selected device when it is outside the visible list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 560 });
  await installTestHooks(page);
  const currentSnapshotRef = {
    value: scheduledSnapshot(await loadViewSnapshotFixture('populated')),
  };
  await installApiRoutes(page, currentSnapshotRef);

  await page.goto('/');
  await waitForViewer(page);

  await page.evaluate(() => {
    const tree = document.querySelector('.tree');
    const row = document.querySelector('.tree-row[data-device-id="router-core"]');
    if (!(tree instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return;
    }
    const testWindow = window as Window & {
      __latticeScrollTest?: (ScrollIntoViewOptions | null)[];
    };

    const treeRect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: 180,
      width: 320,
      height: 180,
      toJSON() {
        return this;
      },
    };
    const rowRect = {
      x: 0,
      y: 260,
      top: 260,
      left: 0,
      right: 320,
      bottom: 308,
      width: 320,
      height: 48,
      toJSON() {
        return this;
      },
    };

    testWindow.__latticeScrollTest = [];
    tree.getBoundingClientRect = () => treeRect as unknown as DOMRect;
    row.getBoundingClientRect = () => rowRect as unknown as DOMRect;
    row.scrollIntoView = (options?: ScrollIntoViewOptions) => {
      testWindow.__latticeScrollTest?.push(options ?? null);
    };
  });

  await clickSceneDevice(page, 'router-core');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const testWindow = window as Window & {
          __latticeScrollTest?: (ScrollIntoViewOptions | null)[];
        };
        return testWindow.__latticeScrollTest?.length ?? 0;
      })
    )
    .toBe(1);

  await expect(
    page.evaluate(() => {
      const testWindow = window as Window & {
        __latticeScrollTest?: (ScrollIntoViewOptions | null)[];
      };
      return testWindow.__latticeScrollTest?.[0] ?? null;
    })
  ).resolves.toEqual({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest',
  });
});

test('hides scene hover cards while rotating and ignores the release click after a drag', async ({
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

  const hoverCard = page.locator('[data-role="hover-card"]');

  await hoverSceneDevice(page, 'router-core');
  await expect(hoverCard).toBeVisible();
  await expect(hoverCard.locator('[data-role="hover-title"]')).toHaveText('vyos-core');
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().hoveredDeviceId)
  ).resolves.toBe('router-core');
  await expect(page.locator('.tree-row[data-device-id="router-core"]')).toHaveClass(/is-hovered/);
  await expect(page.locator('.tree-row[data-device-id="router-core"]')).not.toHaveClass(
    /is-ancestor/
  );
  await expect(page.locator('.tree-row[data-device-id="proxmox-host"]')).not.toHaveClass(
    /is-hovered/
  );

  const releasePoint = await beginSceneDragFromDevice(page, 'router-core', { x: 18, y: 6 });

  await expect(hoverCard).toBeHidden();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().hoveredDeviceId)
  ).resolves.toBe(null);

  await page.mouse.move(releasePoint.clientX + 122, releasePoint.clientY + 22, { steps: 4 });
  await expect(hoverCard).toBeHidden();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().hoveredDeviceId)
  ).resolves.toBe(null);

  await endSceneDrag(page);

  await expect(hoverCard).toBeHidden();
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().hoveredDeviceId)
  ).resolves.toBe(null);
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe(null);

  await dispatchSceneClick(page, await blankScenePoint(page));
  await expect(
    page.evaluate(() => window.__latticeViewer?.getState().selectedDeviceId)
  ).resolves.toBe(null);

  await clickSceneDevice(page, 'router-core');
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
      message: undefined,
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
  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state)
    .toBe('discovering');
  await expect(discoveryControl).toBeDisabled();

  currentSnapshotRef.value = scheduledSnapshot(currentSnapshotRef.value, {
    discovery_status: {
      state: 'ready',
      message: undefined,
    },
    next_auto_discovery_at_ms: Date.now() + 60_000,
  });
  await expect.poll(() => pushMockSnapshot(page, currentSnapshotRef.value)).toBe(true);

  await expect
    .poll(async () => (await discoveryControlMetrics(page))?.state, {
      timeout: 15_000,
    })
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
  await expect(page.locator('[data-role="device-stat-tooltip"]')).toContainText('探索結果の機器数');
  await expect(page.locator('[data-role="device-stat-tooltip"]')).toContainText(
    '直近の探索結果に含まれる機器の総数です。'
  );

  await page.locator('[data-role="link-stat"]').hover();
  await expect(page.locator('[data-role="link-stat-tooltip"]')).toContainText('探索結果のリンク数');
  await expect(page.locator('[data-role="link-stat-tooltip"]')).toContainText(
    '直近の探索結果に含まれる接続の総数です。'
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

test('preserves collapsed state across websocket updates and reconnect refreshes', async ({
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
    .poll(() => page.evaluate(() => window.__latticeViewer?.getState().transport.mode))
    .toBe('connecting');
  await expect
    .poll(() => page.evaluate(() => window.__latticeViewer?.getState().nextAutoDiscoveryAtMs))
    .toBe(currentSnapshotRef.value.next_auto_discovery_at_ms);
});
