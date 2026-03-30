import { describe, expect, it } from 'vitest';

import type { ViewDevice } from '../../src/model/view-snapshot';
import { deviceVisualSpec } from '../../src/topology/device-visuals';

function device(overrides: Partial<ViewDevice> = {}): ViewDevice {
  return {
    id: overrides.id ?? 'device-1',
    label: overrides.label ?? 'device-1',
    depth: overrides.depth ?? 0,
    device_role: overrides.device_role ?? 'unknown',
    deployment_type: overrides.deployment_type ?? 'unknown',
    guest_kind: overrides.guest_kind ?? null,
    identity_keys: overrides.identity_keys ?? {
      chassis_id: null,
      sys_name: null,
      mgmt_ip: null,
      mac_addresses: [],
    },
    host_label: overrides.host_label ?? null,
    upstream_interface: overrides.upstream_interface ?? null,
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
});
