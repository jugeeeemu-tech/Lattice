import type { GuestKind, ViewDevice } from '../model/view-snapshot';

export type DeviceVisualVariant =
  | 'bridge'
  | 'container'
  | 'router'
  | 'server'
  | 'switch'
  | 'unknown';

export type DeviceShapeSpec =
  | { kind: 'box'; depth: number; height: number; width: number }
  | {
      kind: 'cylinder';
      height: number;
      radialSegments: number;
      radiusBottom: number;
      radiusTop: number;
    }
  | { detail: number; kind: 'icosahedron'; radius: number };

export interface DeviceVisualSpec {
  layoutRadius: number;
  shape: DeviceShapeSpec;
  variant: DeviceVisualVariant;
}

export function guestKindLabel(guestKind: GuestKind | null | undefined): string | null {
  switch (guestKind) {
    case 'vm':
      return 'VM';
    case 'container':
      return 'Container';
    default:
      return null;
  }
}

export function deviceGuestKindLabel(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): string | null {
  if (device?.device_role !== 'server') {
    return null;
  }
  return guestKindLabel(device.guest_kind);
}

export function deviceVisualSpec(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): DeviceVisualSpec {
  if (device?.device_role === 'server' && device.guest_kind === 'container') {
    return {
      layoutRadius: 1.25,
      shape: { kind: 'box', width: 1.1, height: 1.1, depth: 1.1 },
      variant: 'container',
    };
  }

  switch (device?.device_role) {
    case 'router':
      return {
        layoutRadius: 1.4,
        shape: {
          kind: 'cylinder',
          radiusTop: 0.92,
          radiusBottom: 0.92,
          height: 1.7,
          radialSegments: 20,
        },
        variant: 'router',
      };
    case 'switch':
      return {
        layoutRadius: 1.7,
        shape: { kind: 'box', width: 2.0, height: 0.28, depth: 1.15 },
        variant: 'switch',
      };
    case 'server':
      return {
        layoutRadius: 1.3,
        shape: { kind: 'box', width: 1.02, height: 1.9, depth: 0.92 },
        variant: 'server',
      };
    case 'bridge':
      return {
        layoutRadius: 1.7,
        shape: { kind: 'box', width: 2.0, height: 1.15, depth: 0.28 },
        variant: 'bridge',
      };
    default:
      return {
        layoutRadius: 1.35,
        shape: { kind: 'icosahedron', radius: 0.98, detail: 0 },
        variant: 'unknown',
      };
  }
}

export function layoutRadiusForDevice(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): number {
  return deviceVisualSpec(device).layoutRadius;
}
