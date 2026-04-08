import type {
  Group,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Sprite,
  Vector3,
} from 'three';

import type { ViewDevice, ViewLink } from '../../generated';

export interface DeviceScreenAnchor {
  visibility: 'behind' | 'offscreen' | 'visible';
  x: number;
  y: number;
}

export interface LinkRuntimeState {
  axis: Vector3;
  backwardHeadPoint: Vector3;
  backwardSegment: { end: Vector3; start: Vector3 };
  billboardNormal: Vector3;
  center: Vector3;
  glowLift: Vector3;
  localEnd: Vector3;
  localGlowStart: Vector3;
  localStart: Vector3;
  normal: Vector3;
  parallelVector: Vector3;
  remoteEnd: Vector3;
  remoteGlowStart: Vector3;
  remoteStart: Vector3;
  surfaceLift: Vector3;
  tangent: Vector3;
  viewDirection: Vector3;
  forwardHeadPoint: Vector3;
  forwardSegment: { end: Vector3; start: Vector3 };
}

export interface LinkVisualState {
  animate: boolean;
  bandColor: number;
  bandOpacity: number;
  dimmed: boolean;
  fillColor: number;
  fillOpacity: number;
  hoverBandVisible: boolean;
  linkGlowColor: number;
  trafficColor: number;
}

export interface DeviceGroup extends Group {
  userData: {
    device: ViewDevice;
    deviceId: string;
    edges: LineSegments;
    kind: 'device';
    material: MeshStandardMaterial;
    mesh: Mesh;
    target: Vector3;
  };
}

export interface LinkGroup extends Group {
  userData: {
    backwardHead: Sprite;
    backwardHeadGlow: Sprite;
    backwardTrail: Mesh;
    hoverBand: Mesh;
    hitMesh: Mesh;
    kind: 'link';
    lastSurfaceKey: string;
    link: ViewLink;
    linkGlow: Mesh;
    linkId: string;
    parallelOffset: number;
    runtime: LinkRuntimeState;
    surface: Mesh;
    visualState: LinkVisualState;
    forwardHead: Sprite;
    forwardHeadGlow: Sprite;
    forwardTrail: Mesh;
  };
}
