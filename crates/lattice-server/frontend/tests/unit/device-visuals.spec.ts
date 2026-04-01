import { describe, expect, it } from 'vitest';

import type { ViewDevice } from '../../src/generated';
import {
  deviceSidebarIconSpec,
  deviceVisualSpec,
} from '../../src/topology/device-visuals';

function device(overrides: Partial<ViewDevice> = {}): ViewDevice {
  return {
    id: overrides.id ?? 'device-1',
    label: overrides.label ?? 'device-1',
    depth: overrides.depth ?? 0,
    device_role: overrides.device_role ?? 'unknown',
    deployment_type: overrides.deployment_type ?? 'unknown',
    guest_kind: overrides.guest_kind,
    identity_keys: overrides.identity_keys ?? {
      mac_addresses: [],
    },
    host_label: overrides.host_label,
    upstream_interface: overrides.upstream_interface,
  };
}

describe('deviceVisualSpec', () => {
  it('maps bridge, switch, router, server, container, and unknown devices to stable specs', () => {
    expect(deviceVisualSpec(device({ device_role: 'bridge' }))).toEqual({
      layoutRadius: 1.7,
      shape: { kind: 'box', width: 2.0, height: 1.15, depth: 0.28 },
      variant: 'bridge',
    });
    expect(deviceVisualSpec(device({ device_role: 'switch' }))).toEqual({
      layoutRadius: 1.7,
      shape: { kind: 'box', width: 2.0, height: 0.28, depth: 1.15 },
      variant: 'switch',
    });
    expect(deviceVisualSpec(device({ device_role: 'router' }))).toEqual({
      layoutRadius: 1.4,
      shape: {
        kind: 'cylinder',
        radiusTop: 0.92,
        radiusBottom: 0.92,
        height: 1.7,
        radialSegments: 20,
      },
      variant: 'router',
    });
    expect(deviceVisualSpec(device({ device_role: 'server' }))).toEqual({
      layoutRadius: 1.3,
      shape: { kind: 'box', width: 1.02, height: 1.9, depth: 0.92 },
      variant: 'server',
    });
    expect(
      deviceVisualSpec(
        device({
          device_role: 'server',
          deployment_type: 'virtual',
          guest_kind: 'container',
        })
      )
    ).toEqual({
      layoutRadius: 1.25,
      shape: { kind: 'box', width: 1.1, height: 1.1, depth: 1.1 },
      variant: 'container',
    });
    expect(deviceVisualSpec(device())).toEqual({
      layoutRadius: 1.35,
      shape: { kind: 'icosahedron', radius: 0.98, detail: 0 },
      variant: 'unknown',
    });
  });

  it('reuses the visual variant when building sidebar icons and keeps distinct 2d shapes', () => {
    expect(deviceSidebarIconSpec(device({ device_role: 'router' }))).toMatchObject({
      variant: 'router',
      bodyPath: expect.any(String),
      topPath: expect.any(String),
      viewBox: '0 0 24 24',
    });

    expect(deviceSidebarIconSpec(device({ device_role: 'switch' }))).toMatchObject({
      variant: 'switch',
      frontPath: expect.any(String),
      sidePath: expect.any(String),
      topPath: expect.any(String),
    });

    expect(deviceSidebarIconSpec(device({ device_role: 'bridge' }))).toMatchObject({
      variant: 'bridge',
      frontPath: 'M6.2 9.8v4.8l11.4 1.8v-4.7L6.2 9.8Z',
      sidePath: 'M17.6 11.6 19 10.2v4.8l-1.4 1.4v-4.8Z',
      topPath: 'M7.6 8.5 19 10.2 17.6 11.6 6.2 9.8 7.6 8.5Z',
    });

    expect(deviceSidebarIconSpec(device({ device_role: 'server' }))).toMatchObject({
      variant: 'server',
      frontPath: 'M6.4 7v10.9l6.4 3.2V10.5L6.4 7Z',
      sidePath: 'M12.8 10.5l4.6-2.7v10.8l-4.6 2.5V10.5Z',
      topPath: 'M11 4.3 17.4 7.8 12.8 10.5 6.4 7 11 4.3Z',
    });

    expect(
      deviceSidebarIconSpec(
        device({
          device_role: 'server',
          guest_kind: 'container',
        })
      )
    ).toMatchObject({
      variant: 'container',
      frontPath: expect.any(String),
      sidePath: expect.any(String),
      topPath: expect.any(String),
    });

    expect(deviceSidebarIconSpec(device())).toMatchObject({
      variant: 'unknown',
      bodyPath: 'M5.2 8.8 12.1 4.8 9.4 10 6.4 14.5 5.2 8.8Z',
      frontPath: 'M9.4 10 14.8 11.1 15.7 16.5 10.4 17.8 6.4 14.5 9.4 10Z',
      sidePath: 'M17.1 7.4 19.3 12.3 15.7 16.5 14.8 11.1 17.1 7.4Z',
      topPath: 'M12.1 4.8 17.1 7.4 14.8 11.1 9.4 10 12.1 4.8Z',
    });

    expect(deviceSidebarIconSpec(device({ device_role: 'router' }))).not.toEqual(
      deviceSidebarIconSpec(device({ device_role: 'server' }))
    );
    expect(deviceSidebarIconSpec(device({ device_role: 'switch' }))).not.toEqual(
      deviceSidebarIconSpec(device({ device_role: 'bridge' }))
    );
    expect(
      deviceSidebarIconSpec(
        device({
          device_role: 'server',
          guest_kind: 'container',
        })
      )
    ).not.toEqual(deviceSidebarIconSpec(device({ device_role: 'server' })));
  });
});
