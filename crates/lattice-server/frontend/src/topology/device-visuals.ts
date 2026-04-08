import type { GuestKind, ViewDevice } from '../generated';

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

export interface DeviceSidebarIconSpec {
  bodyPath?: string;
  frontPath?: string;
  sidePath?: string;
  topPath?: string;
  variant: DeviceVisualVariant;
  viewBox: string;
}

export interface DevicePlanarFootprint {
  halfDepth: number;
  halfWidth: number;
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

export function deviceSidebarIconSpec(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): DeviceSidebarIconSpec {
  const variant = deviceVisualSpec(device).variant;

  switch (variant) {
    case 'router':
      return {
        variant,
        viewBox: '0 0 24 24',
        bodyPath:
          'M5 8.5v7.1c0 1.9 3.1 3.4 7 3.4s7-1.5 7-3.4V8.5c0 1.9-3.1 3.4-7 3.4S5 10.4 5 8.5Z',
        topPath:
          'M12 5c-3.9 0-7 1.5-7 3.4s3.1 3.4 7 3.4 7-1.5 7-3.4S15.9 5 12 5Z',
      };
    case 'switch':
      return {
        variant,
        viewBox: '0 0 24 24',
        frontPath: 'M5.2 10.3v3.1l11.8 1.8v-3.1L5.2 10.3Z',
        sidePath: 'M17 12.1l2-1.9v3.1l-2 1.9v-3.1Z',
        topPath: 'M7.2 8.4 19 10.2 17 12.1 5.2 10.3 7.2 8.4Z',
      };
    case 'server':
      return {
        variant,
        viewBox: '0 0 24 24',
        frontPath: 'M6.4 7v10.9l6.4 3.2V10.5L6.4 7Z',
        sidePath: 'M12.8 10.5l4.6-2.7v10.8l-4.6 2.5V10.5Z',
        topPath: 'M11 4.3 17.4 7.8 12.8 10.5 6.4 7 11 4.3Z',
      };
    case 'bridge':
      return {
        variant,
        viewBox: '0 0 24 24',
        frontPath: 'M6.2 9.8v4.8l11.4 1.8v-4.7L6.2 9.8Z',
        sidePath: 'M17.6 11.6 19 10.2v4.8l-1.4 1.4v-4.8Z',
        topPath: 'M7.6 8.5 19 10.2 17.6 11.6 6.2 9.8 7.6 8.5Z',
      };
    case 'container':
      return {
        variant,
        viewBox: '0 0 24 24',
        frontPath: 'M5.3 9.1v7.5l6.7 3V12L5.3 9.1Z',
        sidePath: 'M12 12l6.7-2.9v7.5l-6.7 3V12Z',
        topPath: 'M12 5.5l6.7 3.6L12 12 5.3 9.1 12 5.5Z',
      };
    default:
      return {
        variant,
        viewBox: '0 0 24 24',
        bodyPath: 'M5.2 8.8 12.1 4.8 9.4 10 6.4 14.5 5.2 8.8Z',
        frontPath: 'M9.4 10 14.8 11.1 15.7 16.5 10.4 17.8 6.4 14.5 9.4 10Z',
        sidePath: 'M17.1 7.4 19.3 12.3 15.7 16.5 14.8 11.1 17.1 7.4Z',
        topPath: 'M12.1 4.8 17.1 7.4 14.8 11.1 9.4 10 12.1 4.8Z',
      };
  }
}

export function layoutRadiusForDevice(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): number {
  return deviceVisualSpec(device).layoutRadius;
}

export function devicePlanarFootprint(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): DevicePlanarFootprint {
  const spec = deviceVisualSpec(device);
  switch (spec.shape.kind) {
    case 'box':
      return {
        halfWidth: spec.shape.width / 2,
        halfDepth: spec.shape.depth / 2,
      };
    case 'cylinder': {
      const radius = Math.max(spec.shape.radiusTop, spec.shape.radiusBottom);
      return { halfWidth: radius, halfDepth: radius };
    }
    case 'icosahedron':
      return { halfWidth: spec.shape.radius, halfDepth: spec.shape.radius };
  }
}

export function devicePlanarMaxDiameter(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): number {
  const footprint = devicePlanarFootprint(device);
  return Math.max(footprint.halfWidth * 2, footprint.halfDepth * 2);
}

export function devicePlanarSupport(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined,
  dirX: number,
  dirZ: number
): number {
  const footprint = devicePlanarFootprint(device);
  const magnitude = Math.hypot(dirX, dirZ);
  if (magnitude < 0.0001) {
    return Math.max(footprint.halfWidth, footprint.halfDepth);
  }
  const unitX = dirX / magnitude;
  const unitZ = dirZ / magnitude;
  return Math.abs(unitX) * footprint.halfWidth + Math.abs(unitZ) * footprint.halfDepth;
}

export function devicePlanarClearance(
  device: Pick<ViewDevice, 'device_role' | 'guest_kind'> | null | undefined
): number {
  const spec = deviceVisualSpec(device);
  switch (spec.shape.kind) {
    case 'box':
      return Math.max(spec.shape.width, spec.shape.depth) >= 1.8 ? 0.34 : 0.28;
    case 'cylinder':
      return 0.26;
    case 'icosahedron':
      return 0.24;
  }
}
