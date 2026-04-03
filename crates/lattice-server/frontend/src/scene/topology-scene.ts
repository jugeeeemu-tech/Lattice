import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  FrontSide,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { ViewDevice, ViewLink } from '../generated';
import type { TopologyStoreState } from '../state/topology-store';
import { projectionInsetFromDesktopInset } from './scene-layout';
import {
  deploymentColor,
  networkCidrColor,
  primaryNetworkCidr,
} from '../topology/view-model';
import { deviceVisualSpec, layoutRadiusForDevice } from '../topology/device-visuals';

type SceneHoverTarget =
  | { deviceId: string; kind: 'device' }
  | { kind: 'link'; linkId: string }
  | null;

interface DeviceGroup extends Group {
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

interface LinkGroup extends Group {
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

function clampMagnitude(value: number, limit: number): number {
  return Math.max(-limit, Math.min(value, limit));
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function hash01(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

export function recenterPositionsAroundRootCentroid(
  positions: Map<string, Vector3>,
  rootIds: Iterable<string>
): Map<string, Vector3> {
  const roots = Array.from(rootIds)
    .map((rootId) => positions.get(rootId))
    .filter((position): position is Vector3 => Boolean(position));

  if (roots.length <= 1) {
    return positions;
  }

  const centroid = new Vector3();
  for (const position of roots) {
    centroid.add(position);
  }
  centroid.divideScalar(roots.length);

  if (Math.abs(centroid.x) < 0.0001 && Math.abs(centroid.z) < 0.0001) {
    return positions;
  }

  for (const position of positions.values()) {
    position.x -= centroid.x;
    position.z -= centroid.z;
  }

  return positions;
}

interface RelationLayoutInput {
  childIdsByDeviceId: Map<string, string[]>;
  deviceById: Map<string, ViewDevice>;
  parentIdsByDeviceId: Map<string, string[]>;
  peerIdsByDeviceId: Map<string, string[]>;
  primaryChildrenByDeviceId: Map<string, string[]>;
  primaryParentDeviceById: Map<string, string>;
  rootDeviceIds: string[];
}

export interface RelationLayoutGraph {
  childIdsByDeviceId: Map<string, string[]>;
  depthByDeviceId: Map<string, number>;
  parentIdsByDeviceId: Map<string, string[]>;
  peerIdsByDeviceId: Map<string, string[]>;
  rootDescendantIdsByRootId: Map<string, string[]>;
  rootDeviceIds: string[];
  rootMassByDeviceId: Map<string, number>;
  rootShareByDeviceId: Map<string, Map<string, number>>;
}

function sortedVisibleIds(
  ids: Iterable<string>,
  visibleIds: Set<string>,
  deviceById: Map<string, ViewDevice>
): string[] {
  return Array.from(new Set(Array.from(ids).filter((deviceId) => visibleIds.has(deviceId)))).sort(
    (leftId, rightId) =>
      `${deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
        `${deviceById.get(rightId)?.label ?? rightId}`
      )
  );
}

function normalizeRootShare(weights: Map<string, number>): Map<string, number> {
  const total = Array.from(weights.values()).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return new Map();
  }

  return new Map(
    Array.from(weights.entries())
      .map(([rootId, value]) => [rootId, value / total] as const)
      .filter(([, value]) => value > 0.0001)
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
  );
}

export function buildRelationLayoutGraph(
  visibleDeviceIds: Iterable<string>,
  model: RelationLayoutInput
): RelationLayoutGraph {
  const visibleIds = new Set(visibleDeviceIds);
  const hasRelationData =
    model.rootDeviceIds.length > 0 ||
    Array.from(visibleIds).some((deviceId) => {
      const parentCount = model.parentIdsByDeviceId.get(deviceId)?.length ?? 0;
      const childCount = model.childIdsByDeviceId.get(deviceId)?.length ?? 0;
      const peerCount = model.peerIdsByDeviceId.get(deviceId)?.length ?? 0;
      return parentCount > 0 || childCount > 0 || peerCount > 0;
    });

  const childIdsByDeviceId = new Map<string, string[]>();
  const parentIdsByDeviceId = new Map<string, string[]>();
  const peerIdsByDeviceId = new Map<string, string[]>();

  for (const deviceId of visibleIds) {
    if (hasRelationData) {
      childIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.childIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
      parentIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.parentIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
      peerIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.peerIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
    } else {
      childIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(
          model.primaryChildrenByDeviceId.get(deviceId) ?? [],
          visibleIds,
          model.deviceById
        )
      );
      const parentId = model.primaryParentDeviceById.get(deviceId);
      parentIdsByDeviceId.set(
        deviceId,
        parentId && visibleIds.has(parentId) ? [parentId] : []
      );
      peerIdsByDeviceId.set(deviceId, []);
    }
  }

  const roots = hasRelationData
    ? sortedVisibleIds(model.rootDeviceIds, visibleIds, model.deviceById)
    : sortedVisibleIds(
        Array.from(visibleIds).filter((deviceId) => (parentIdsByDeviceId.get(deviceId)?.length ?? 0) === 0),
        visibleIds,
        model.deviceById
      );

  if (roots.length === 0) {
    roots.push(
      ...sortedVisibleIds(
        Array.from(visibleIds).filter((deviceId) => (parentIdsByDeviceId.get(deviceId)?.length ?? 0) === 0),
        visibleIds,
        model.deviceById
      )
    );
  }

  const depthByDeviceId = new Map<string, number>();
  const queue = roots.map((deviceId) => ({ depth: 0, deviceId }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const existingDepth = depthByDeviceId.get(current.deviceId);
    if (existingDepth !== undefined && existingDepth <= current.depth) {
      continue;
    }

    depthByDeviceId.set(current.deviceId, current.depth);
    for (const childId of childIdsByDeviceId.get(current.deviceId) ?? []) {
      queue.push({ depth: current.depth + 1, deviceId: childId });
    }
  }

  const unresolvedIds = sortedVisibleIds(
    Array.from(visibleIds).filter((deviceId) => !depthByDeviceId.has(deviceId)),
    visibleIds,
    model.deviceById
  );
  for (const deviceId of unresolvedIds) {
    depthByDeviceId.set(deviceId, 0);
    if (!roots.includes(deviceId)) {
      roots.push(deviceId);
    }
  }

  const rootShareByDeviceId = new Map<string, Map<string, number>>();
  for (const rootId of roots) {
    rootShareByDeviceId.set(rootId, new Map([[rootId, 1]]));
  }

  const devicesByDepth = Array.from(depthByDeviceId.entries())
    .sort(
      ([leftId, leftDepth], [rightId, rightDepth]) =>
        leftDepth - rightDepth ||
        `${model.deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
          `${model.deviceById.get(rightId)?.label ?? rightId}`
        )
    )
    .map(([deviceId]) => deviceId);

  for (const deviceId of devicesByDepth) {
    if (rootShareByDeviceId.has(deviceId)) {
      continue;
    }

    const parentIds = parentIdsByDeviceId
      .get(deviceId)
      ?.filter((parentId) => rootShareByDeviceId.has(parentId)) ?? [];
    if (parentIds.length === 0) {
      rootShareByDeviceId.set(deviceId, new Map());
      continue;
    }

    const combined = new Map<string, number>();
    for (const parentId of parentIds) {
      for (const [rootId, share] of rootShareByDeviceId.get(parentId) ?? []) {
        combined.set(rootId, (combined.get(rootId) ?? 0) + share);
      }
    }
    rootShareByDeviceId.set(deviceId, normalizeRootShare(combined));
  }

  const rootDescendantIdsByRootId = new Map<string, string[]>(
    roots.map((rootId) => [rootId, [] as string[]])
  );
  const rootMassByDeviceId = new Map<string, number>(roots.map((rootId) => [rootId, 0]));

  for (const deviceId of devicesByDepth) {
    const childCount = childIdsByDeviceId.get(deviceId)?.length ?? 0;
    const peerCount = peerIdsByDeviceId.get(deviceId)?.length ?? 0;
    const deviceWeight = 1 + childCount * 0.45 + peerCount * 0.2;
    for (const [rootId, share] of rootShareByDeviceId.get(deviceId) ?? []) {
      const descendantIds = rootDescendantIdsByRootId.get(rootId) ?? [];
      descendantIds.push(deviceId);
      rootDescendantIdsByRootId.set(rootId, descendantIds);
      rootMassByDeviceId.set(rootId, (rootMassByDeviceId.get(rootId) ?? 0) + deviceWeight * share);
    }
  }

  for (const [rootId, descendantIds] of rootDescendantIdsByRootId.entries()) {
    rootDescendantIdsByRootId.set(
      rootId,
      sortedVisibleIds(descendantIds, visibleIds, model.deviceById)
    );
  }

  return {
    childIdsByDeviceId,
    depthByDeviceId,
    parentIdsByDeviceId,
    peerIdsByDeviceId,
    rootDescendantIdsByRootId,
    rootDeviceIds: roots,
    rootMassByDeviceId,
    rootShareByDeviceId,
  };
}

export function buildRelationRootAnchors(
  graph: RelationLayoutGraph
): Map<string, Vector3> {
  const roots = graph.rootDeviceIds;
  const anchors = new Map<string, Vector3>();
  if (roots.length === 0) {
    return anchors;
  }

  if (roots.length === 1) {
    anchors.set(roots[0], new Vector3(0, 0, 0));
    return anchors;
  }

  const membershipCountByDeviceId = new Map<string, number>();
  for (const descendantIds of graph.rootDescendantIdsByRootId.values()) {
    for (const deviceId of descendantIds) {
      membershipCountByDeviceId.set(deviceId, (membershipCountByDeviceId.get(deviceId) ?? 0) + 1);
    }
  }

  const sharedDeviceCount = Array.from(membershipCountByDeviceId.values()).filter((count) => count > 1).length;
  const totalMass = roots.reduce((sum, rootId) => sum + (graph.rootMassByDeviceId.get(rootId) ?? 1), 0);
  const sharedRatio =
    membershipCountByDeviceId.size > 0 ? sharedDeviceCount / membershipCountByDeviceId.size : 0;

  if (roots.length === 2) {
    const spacing = Math.max(5.5, Math.min(9.5, 7.8 + Math.sqrt(totalMass) * 0.18 - sharedRatio * 2.2));
    anchors.set(roots[0], new Vector3(-spacing / 2, 0, 0));
    anchors.set(roots[1], new Vector3(spacing / 2, 0, 0));
    return anchors;
  }

  const radius = Math.max(5.8, Math.min(10.5, 5.8 + Math.sqrt(totalMass) * 0.18 - sharedRatio * 1.4));
  for (let index = 0; index < roots.length; index += 1) {
    const angle = (Math.PI * 2 * index) / roots.length - Math.PI / 2;
    anchors.set(
      roots[index],
      new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    );
  }

  return anchors;
}

export interface DeviceScreenAnchor {
  visibility: 'behind' | 'offscreen' | 'visible';
  x: number;
  y: number;
}

const ROTATION_DRAG_THRESHOLD_PX = 4;
const WORLD_UP = new Vector3(0, 1, 0);
const TRAFFIC_SURFACE_LIFT = 0.05;
const BASE_LINK_STYLE = {
  bandOpacity: 0.28,
  boundarySoftness: 0.02,
  edgeSoftness: 0.025,
  fillWidth: 0.3,
  outlineWidth: 0.56,
  ribbonOpacity: 0.96,
};
const HOVER_BAND_STYLE = {
  color: 0xcec0ff,
  opacity: 0.82,
  softness: 0.04,
};
const TRAFFIC_GLOW_STYLE = {
  headOpacityScale: 0.5,
  headScaleMultiplier: 2.7,
  tailOpacityScale: 0.5,
  tailWidthMultiplier: 2.7,
};
const LINK_GLOW_STYLE = {
  opacity: 0.58,
  radius: 0.16,
  widthScale: 1.72,
  widthSoftness: 1.02,
};
const TRAFFIC_DEFAULTS = {
  burstCount: 2,
  intervalSeconds: 1,
  speedMultiplier: 0.75,
  tailDecayExponent: 0.55,
  tailLengthMultiplier: 2.4,
  tailRootReach: 0.95,
  tailRootWidthScale: 2.4,
};
const TRAFFIC_VARIANT = {
  baseOpacity: 0.9,
  headOpacityBoost: 0.2,
  headScale: 0.44,
  streakLength: 0.16,
  streakWidth: 0.052,
  tintMix: 0.52,
};
const SHARED_RIBBON_GEOMETRY = createSharedRibbonGeometry();
let TRAFFIC_HEAD_TEXTURE: CanvasTexture | null = null;
const RIBBON_TANGENT = new Vector3();
const RIBBON_BINORMAL = new Vector3();
const RIBBON_MATRIX = new Matrix4();

interface LinkRuntimeState {
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

interface LinkVisualState {
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

interface BurstState {
  headT: number;
  lengthT: number;
  opacity: number;
  visible: boolean;
}

interface TailShape {
  coreWidth: number;
  decayExponent: number;
  glowStrength: number;
  glowWidth: number;
  rootReach: number;
  rootWidthScale: number;
  tailFloor: number;
  tipWidth: number;
}

export function computeParallelLinkOffsets(links: ReadonlyArray<ViewLink>): Map<string, number> {
  const byPair = new Map<string, ViewLink[]>();
  for (const link of links) {
    const key = pairKey(link.local_device_id, link.remote_device_id);
    const bucket = byPair.get(key) ?? [];
    bucket.push(link);
    byPair.set(key, bucket);
  }

  const offsets = new Map<string, number>();
  for (const bucket of byPair.values()) {
    bucket.sort((left, right) => left.id.localeCompare(right.id));
    const midpoint = (bucket.length - 1) / 2;
    for (const [index, link] of bucket.entries()) {
      offsets.set(link.id, (index - midpoint) * 0.48);
    }
  }

  return offsets;
}

const LINK_SURFACE_SHADER = {
  fragment: `
    varying vec2 vUv;

    uniform vec3 uBandColor;
    uniform vec3 uFillColor;
    uniform float uBandOpacity;
    uniform float uBoundarySoftness;
    uniform float uEdgeSoftness;
    uniform float uFillOpacity;
    uniform float uFillRatio;

    void main() {
      float centered = abs(vUv.x * 2.0 - 1.0);
      float fillMask = 1.0 - smoothstep(
        max(0.0, uFillRatio - uBoundarySoftness),
        min(1.0, uFillRatio + uBoundarySoftness),
        centered
      );
      float edgeFade = 1.0 - smoothstep(1.0 - uEdgeSoftness, 1.0, centered);
      float outerAlpha = uBandOpacity;
      vec3 outerColor = uBandColor;

      float innerAlpha = uFillOpacity + uBandOpacity * (1.0 - uFillOpacity);
      vec3 innerColor = (
        uFillColor * uFillOpacity +
        uBandColor * uBandOpacity * (1.0 - uFillOpacity)
      ) / max(innerAlpha, 0.0001);

      vec3 color = mix(outerColor, innerColor, fillMask);
      float alpha = mix(outerAlpha, innerAlpha, fillMask) * edgeFade;

      if (alpha < 0.002) {
        discard;
      }

      gl_FragColor = vec4(color, alpha);
    }
  `,
  vertex: `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
};

const HOVER_BAND_SHADER = {
  fragment: `
    varying vec2 vUv;

    uniform vec3 uBandColor;
    uniform float uBandOpacity;
    uniform float uFillRatio;
    uniform float uBoundarySoftness;
    uniform float uEdgeSoftness;

    void main() {
      float centered = abs(vUv.x * 2.0 - 1.0);
      float innerCut = smoothstep(
        max(0.0, uFillRatio - uBoundarySoftness),
        min(1.0, uFillRatio + uBoundarySoftness),
        centered
      );
      float edgeFade = 1.0 - smoothstep(1.0 - uEdgeSoftness, 1.0, centered);
      float alpha = uBandOpacity * innerCut * edgeFade;

      if (alpha < 0.002) {
        discard;
      }

      gl_FragColor = vec4(uBandColor, alpha);
    }
  `,
  vertex: LINK_SURFACE_SHADER.vertex,
};

const TRAFFIC_TRAIL_SHADER = {
  fragment: `
    varying vec2 vUv;

    uniform vec3 uCoreColor;
    uniform vec3 uGlowColor;
    uniform float uOpacity;
    uniform float uDecayExponent;
    uniform float uTailFloor;
    uniform float uTipWidth;
    uniform float uRootWidthScale;
    uniform float uRootReach;
    uniform float uCoreWidth;
    uniform float uGlowWidth;
    uniform float uGlowStrength;

    void main() {
      float along = clamp(vUv.y, 0.0, 1.0);
      float startFade = smoothstep(0.0, 0.08, along);
      float endFade = 1.0 - smoothstep(0.965, 1.0, along);
      float fadeCurve = pow(along, uDecayExponent);
      float lengthFade = mix(uTailFloor, 1.0, fadeCurve) * startFade * endFade;
      float headBoost = 0.82 + smoothstep(0.42, 1.0, along) * 0.28;
      float taper = mix(uTipWidth, 1.0, pow(along, 0.78));
      float rootGrowth = mix(1.0, uRootWidthScale, smoothstep(1.0 - uRootReach, 1.0, along));
      float widthScale = taper * rootGrowth;
      float centered = abs(vUv.x * 2.0 - 1.0);
      float coreMask = pow(max(0.0, 1.0 - centered / max(uCoreWidth * widthScale, 0.001)), 4.2);
      float glowMask = pow(max(0.0, 1.0 - centered / max(uGlowWidth * widthScale, 0.001)), 2.0);

      float coreAlpha = uOpacity * lengthFade * headBoost * coreMask;
      float glowAlpha = uOpacity * lengthFade * headBoost * glowMask * uGlowStrength;
      float alpha = max(coreAlpha, glowAlpha);

      if (alpha < 0.002) {
        discard;
      }

      vec3 color = uGlowColor * glowAlpha + uCoreColor * coreAlpha;
      gl_FragColor = vec4(color, alpha);
    }
  `,
  vertex: LINK_SURFACE_SHADER.vertex,
};

const LINK_GLOW_SHADER = {
  fragment: `
    varying vec2 vUv;

    uniform vec3 uGlowColor;
    uniform float uOpacity;
    uniform float uForwardHeadT;
    uniform float uBackwardHeadT;
    uniform float uRadius;
    uniform float uWidthSoftness;

    float lobe(float along, float center, float radius) {
      float dist = abs(along - center);
      return pow(max(0.0, 1.0 - dist / max(radius, 0.001)), 2.2);
    }

    void main() {
      float along = clamp(vUv.y, 0.0, 1.0);
      float centered = abs(vUv.x * 2.0 - 1.0);
      float widthMask = pow(max(0.0, 1.0 - centered / max(uWidthSoftness, 0.001)), 2.0);
      float forwardGlow = lobe(along, uForwardHeadT, uRadius);
      float backwardGlow = lobe(along, uBackwardHeadT, uRadius);
      float alpha = uOpacity * widthMask * max(forwardGlow, backwardGlow);

      if (alpha < 0.002) {
        discard;
      }

      gl_FragColor = vec4(uGlowColor, alpha);
    }
  `,
  vertex: LINK_SURFACE_SHADER.vertex,
};

function mixColor(left: number, right: number, amount: number): number {
  const clamped = Math.max(0, Math.min(amount, 1));
  const leftColor = new Color(left);
  const rightColor = new Color(right);
  leftColor.lerp(rightColor, clamped);
  return leftColor.getHex();
}

function darkenColor(color: number, factor: number): number {
  const source = new Color(color);
  source.multiplyScalar(Math.max(0, Math.min(factor, 1)));
  return source.getHex();
}

function createSharedRibbonGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        -0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0,
      ]),
      3
    )
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

function createHeadTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    const fallback = new CanvasTexture(canvas);
    fallback.colorSpace = SRGBColorSpace;
    return fallback;
  }

  const gradient = context.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.08,
    size * 0.5,
    size * 0.5,
    size * 0.5
  );
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.98)');
  gradient.addColorStop(0.42, 'rgba(255, 255, 255, 0.42)');
  gradient.addColorStop(0.72, 'rgba(255, 255, 255, 0.1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createLinkRuntimeState(): LinkRuntimeState {
  return {
    axis: new Vector3(),
    backwardHeadPoint: new Vector3(),
    backwardSegment: { end: new Vector3(), start: new Vector3() },
    billboardNormal: new Vector3(),
    center: new Vector3(),
    glowLift: new Vector3(),
    localEnd: new Vector3(),
    localGlowStart: new Vector3(),
    localStart: new Vector3(),
    normal: new Vector3(),
    parallelVector: new Vector3(),
    remoteEnd: new Vector3(),
    remoteGlowStart: new Vector3(),
    remoteStart: new Vector3(),
    surfaceLift: new Vector3(),
    tangent: new Vector3(),
    viewDirection: new Vector3(),
    forwardHeadPoint: new Vector3(),
    forwardSegment: { end: new Vector3(), start: new Vector3() },
  };
}

function createRibbonBaseMesh(width: number): Mesh {
  const mesh = new Mesh(
    SHARED_RIBBON_GEOMETRY,
    new MeshBasicMaterial({
      depthWrite: false,
      side: FrontSide,
      transparent: true,
    })
  );
  mesh.userData.ribbonWidth = width;
  return mesh;
}

function createLinkSurfaceMesh(): Mesh {
  const mesh = createRibbonBaseMesh(BASE_LINK_STYLE.outlineWidth);
  (mesh.material as MeshBasicMaterial).dispose();
  mesh.material = new ShaderMaterial({
    depthTest: true,
    depthWrite: false,
    fragmentShader: LINK_SURFACE_SHADER.fragment,
    side: FrontSide,
    transparent: true,
    uniforms: {
      uBandColor: { value: new Color(0x4b5563) },
      uBandOpacity: { value: BASE_LINK_STYLE.bandOpacity },
      uBoundarySoftness: { value: BASE_LINK_STYLE.boundarySoftness },
      uEdgeSoftness: { value: BASE_LINK_STYLE.edgeSoftness },
      uFillColor: { value: new Color(0x64748b) },
      uFillOpacity: { value: BASE_LINK_STYLE.ribbonOpacity },
      uFillRatio: { value: BASE_LINK_STYLE.fillWidth / BASE_LINK_STYLE.outlineWidth },
    },
    vertexShader: LINK_SURFACE_SHADER.vertex,
  });
  (mesh.material as ShaderMaterial).forceSinglePass = true;
  return mesh;
}

function createHoverBandMesh(): Mesh {
  const mesh = createRibbonBaseMesh(BASE_LINK_STYLE.outlineWidth);
  (mesh.material as MeshBasicMaterial).dispose();
  mesh.material = new ShaderMaterial({
    depthTest: true,
    depthWrite: false,
    fragmentShader: HOVER_BAND_SHADER.fragment,
    side: FrontSide,
    transparent: true,
    uniforms: {
      uBandColor: { value: new Color(HOVER_BAND_STYLE.color) },
      uBandOpacity: { value: HOVER_BAND_STYLE.opacity },
      uBoundarySoftness: { value: HOVER_BAND_STYLE.softness },
      uEdgeSoftness: { value: BASE_LINK_STYLE.edgeSoftness },
      uFillRatio: { value: BASE_LINK_STYLE.fillWidth / BASE_LINK_STYLE.outlineWidth },
    },
    vertexShader: HOVER_BAND_SHADER.vertex,
  });
  (mesh.material as ShaderMaterial).forceSinglePass = true;
  mesh.visible = false;
  return mesh;
}

function computeTrailBillboardWidth(): number {
  const headMatchedWidth = TRAFFIC_VARIANT.headScale * 1.15;
  const minimumTrailWidth = TRAFFIC_VARIANT.streakWidth * TRAFFIC_GLOW_STYLE.tailWidthMultiplier * 1.8;
  return Math.max(headMatchedWidth, minimumTrailWidth);
}

function createTrafficTrailMesh(coreColor: number, glowColor: number): Mesh {
  const mesh = createRibbonBaseMesh(computeTrailBillboardWidth());
  (mesh.material as MeshBasicMaterial).dispose();
  mesh.material = new ShaderMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    fragmentShader: TRAFFIC_TRAIL_SHADER.fragment,
    side: FrontSide,
    transparent: true,
    uniforms: {
      uCoreColor: { value: new Color(coreColor) },
      uCoreWidth: { value: 0.36 },
      uDecayExponent: { value: 0.55 },
      uGlowColor: { value: new Color(glowColor) },
      uGlowStrength: { value: TRAFFIC_GLOW_STYLE.tailOpacityScale * 1.18 },
      uGlowWidth: { value: 1.02 },
      uOpacity: { value: 0 },
      uRootReach: { value: 0.95 },
      uRootWidthScale: { value: 2.4 },
      uTailFloor: { value: 0.22 },
      uTipWidth: { value: 0.22 },
    },
    vertexShader: TRAFFIC_TRAIL_SHADER.vertex,
  });
  (mesh.material as ShaderMaterial).forceSinglePass = true;
  mesh.visible = false;
  return mesh;
}

function createLinkGlowMesh(glowColor: number): Mesh {
  const mesh = createRibbonBaseMesh(BASE_LINK_STYLE.fillWidth * LINK_GLOW_STYLE.widthScale);
  (mesh.material as MeshBasicMaterial).dispose();
  mesh.material = new ShaderMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    fragmentShader: LINK_GLOW_SHADER.fragment,
    side: FrontSide,
    transparent: true,
    uniforms: {
      uBackwardHeadT: { value: 0 },
      uForwardHeadT: { value: 0 },
      uGlowColor: { value: new Color(glowColor) },
      uOpacity: { value: 0 },
      uRadius: { value: LINK_GLOW_STYLE.radius },
      uWidthSoftness: { value: LINK_GLOW_STYLE.widthSoftness },
    },
    vertexShader: LINK_GLOW_SHADER.vertex,
  });
  (mesh.material as ShaderMaterial).forceSinglePass = true;
  mesh.visible = false;
  return mesh;
}

function createHeadSprite(color: number, scale: number): Sprite {
  if (!TRAFFIC_HEAD_TEXTURE) {
    TRAFFIC_HEAD_TEXTURE = createHeadTexture();
  }
  const sprite = new Sprite(
    new SpriteMaterial({
      color,
      depthWrite: false,
      map: TRAFFIC_HEAD_TEXTURE,
      opacity: 1,
      transparent: true,
    })
  );
  sprite.material.blending = AdditiveBlending;
  sprite.scale.setScalar(scale);
  sprite.visible = false;
  return sprite;
}

function computeBurstState(elapsedSeconds: number): BurstState {
  const interval = Math.max(0.05, TRAFFIC_DEFAULTS.intervalSeconds);
  const repeatCount = Math.max(1, Math.floor(TRAFFIC_DEFAULTS.burstCount));
  const phase = elapsedSeconds % interval;
  const activeDuration = Math.max(
    0.08,
    Math.min(interval * 0.82, 0.26 / Math.max(TRAFFIC_DEFAULTS.speedMultiplier, 0.25))
  );
  const burstSequenceDuration = activeDuration * repeatCount;
  if (phase > burstSequenceDuration) {
    return { headT: 0, lengthT: 0, opacity: 0, visible: false };
  }

  const burstIndexPhase = phase % activeDuration;
  const progress = burstIndexPhase / Math.max(activeDuration, 0.001);
  const speedLengthFactor = 1 / Math.max(TRAFFIC_DEFAULTS.speedMultiplier, 0.25);
  const lengthT = Math.max(
    0.04,
    Math.min(0.56, TRAFFIC_VARIANT.streakLength * speedLengthFactor * TRAFFIC_DEFAULTS.tailLengthMultiplier)
  );
  const headT = -lengthT * 0.5 + progress * (1 + lengthT);
  const envelope = Math.sin(progress * Math.PI);

  return {
    headT,
    lengthT,
    opacity: Math.max(0.18, Math.min(1, TRAFFIC_VARIANT.baseOpacity * (0.4 + envelope * 0.9))),
    visible: true,
  };
}

function computeTailShape(): TailShape {
  const safeExponent = Math.max(TRAFFIC_DEFAULTS.tailDecayExponent, 0.1);
  const normalized = Math.max(0, Math.min(1, (safeExponent - 0.55) / (2.2 - 0.55)));
  return {
    coreWidth: Math.max(0.28, Math.min(0.44, 0.42 - normalized * 0.1)),
    decayExponent: 0.72 + normalized * 2.1,
    glowStrength: Math.max(0.28, Math.min(0.62, 0.54 - normalized * 0.16)),
    glowWidth: Math.max(0.96, Math.min(1.22, 1.18 - normalized * 0.08)),
    rootReach: Math.max(0.2, Math.min(0.95, TRAFFIC_DEFAULTS.tailRootReach)),
    rootWidthScale: Math.max(0.85, Math.min(2.4, TRAFFIC_DEFAULTS.tailRootWidthScale)),
    tailFloor: Math.max(0.18, Math.min(0.46, 0.44 - normalized * 0.22)),
    tipWidth: Math.max(0.1, Math.min(0.5, 0.46 - normalized * 0.28)),
  };
}

function setPointAlongLink(out: Vector3, sourcePoint: Vector3, targetPoint: Vector3, t: number): boolean {
  if (t < 0 || t > 1) {
    return false;
  }
  out.copy(sourcePoint).lerp(targetPoint, t);
  return true;
}

function setTrailingSegment(
  segment: { end: Vector3; start: Vector3 },
  sourcePoint: Vector3,
  targetPoint: Vector3,
  headT: number,
  lengthT: number
): boolean {
  const startT = Math.max(0, headT - lengthT);
  const endT = Math.min(1, headT);
  if (endT - startT <= 0.005) {
    return false;
  }

  segment.start.copy(sourcePoint).lerp(targetPoint, startT);
  segment.end.copy(sourcePoint).lerp(targetPoint, endT);
  return true;
}

function placeRibbonMesh(mesh: Mesh, start: Vector3, end: Vector3, normal: Vector3, width: number): boolean {
  RIBBON_TANGENT.subVectors(end, start);
  const length = RIBBON_TANGENT.length();
  if (length < 0.000001) {
    mesh.visible = false;
    return false;
  }

  RIBBON_TANGENT.multiplyScalar(1 / length);
  RIBBON_BINORMAL.crossVectors(normal, RIBBON_TANGENT);
  if (RIBBON_BINORMAL.lengthSq() < 0.000001) {
    RIBBON_BINORMAL.crossVectors(normal, WORLD_UP);
  }
  RIBBON_BINORMAL.normalize();
  RIBBON_MATRIX.makeBasis(normal, RIBBON_TANGENT, RIBBON_BINORMAL);
  mesh.position.copy(start);
  mesh.quaternion.setFromRotationMatrix(RIBBON_MATRIX);
  mesh.scale.set(width, length, 1);
  mesh.visible = true;
  return true;
}

function computeLinkFrame(
  frame: LinkRuntimeState,
  localPoint: Vector3,
  remotePoint: Vector3,
  cameraPosition: Vector3,
  parallelOffset: number
): boolean {
  frame.axis.subVectors(remotePoint, localPoint);
  if (frame.axis.lengthSq() < 0.000001) {
    return false;
  }

  frame.center.copy(localPoint).add(remotePoint).multiplyScalar(0.5);
  frame.viewDirection.copy(cameraPosition).sub(frame.center).normalize();
  frame.tangent.copy(frame.axis).normalize();
  frame.normal.crossVectors(frame.tangent, frame.viewDirection);
  if (frame.normal.lengthSq() < 0.000001) {
    frame.normal.crossVectors(frame.tangent, WORLD_UP);
  }
  frame.normal.normalize();
  frame.parallelVector.copy(frame.normal).multiplyScalar(parallelOffset);
  frame.localEnd.copy(localPoint).add(frame.parallelVector);
  frame.remoteEnd.copy(remotePoint).add(frame.parallelVector);
  frame.billboardNormal.crossVectors(frame.normal, frame.tangent);
  if (frame.billboardNormal.dot(frame.viewDirection) < 0) {
    frame.billboardNormal.multiplyScalar(-1);
  }
  frame.billboardNormal.normalize();
  frame.surfaceLift.copy(frame.billboardNormal).multiplyScalar(TRAFFIC_SURFACE_LIFT);
  return true;
}

export class TopologySceneAdapter {
  #host: HTMLElement;
  #onHoverTarget: (target: SceneHoverTarget, pointer?: { x: number; y: number }) => void;
  #onClearHover: () => void;
  #onSelectDevice: (deviceId: string) => void;

  #state: TopologyStoreState | null = null;
  #scene = new Scene();
  #camera = new PerspectiveCamera(42, 1, 0.1, 400);
  #renderer = new WebGLRenderer({ antialias: true, alpha: true });
  #controls: OrbitControls;
  #deviceRoot = new Group();
  #linkRoot = new Group();
  #raycaster = new Raycaster();
  #pointer = new Vector2();
  #hoverPointer = { x: 0, y: 0 };
  #primaryPointerId: number | null = null;
  #pointerDownPosition: { x: number; y: number } | null = null;
  #sceneDragInProgress = false;
  #suppressNextClick = false;
  #resizeObserver: ResizeObserver | null = null;
  #deviceGroups = new Map<string, DeviceGroup>();
  #linkGroups = new Map<string, LinkGroup>();
  #positionCache = new Map<string, Vector3>();
  #frameHandle = 0;
  #framedScene = false;
  #desktopLeftInset = 0;
  #lastFrameSignature: string | null = null;
  #lastVisibleDeviceById = new Map<string, ViewDevice>();
  #lastTargetByDeviceId = new Map<string, Vector3>();

  constructor(options: {
    host: HTMLElement;
    onClearHover: () => void;
    onHoverTarget: (target: SceneHoverTarget, pointer?: { x: number; y: number }) => void;
    onSelectDevice: (deviceId: string) => void;
  }) {
    this.#host = options.host;
    this.#onHoverTarget = options.onHoverTarget;
    this.#onClearHover = options.onClearHover;
    this.#onSelectDevice = options.onSelectDevice;

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#installScene();
  }

  dispose(): void {
    if (this.#frameHandle) {
      window.cancelAnimationFrame(this.#frameHandle);
      this.#frameHandle = 0;
    }
    this.#resizeObserver?.disconnect();
    this.#controls.dispose();
    this.#renderer.dispose();
    this.#renderer.domElement.remove();
  }

  setDesktopLeftInset(leftInset: number): void {
    const normalizedInset = Math.max(0, leftInset);
    if (Math.abs(this.#desktopLeftInset - normalizedInset) < 0.5) {
      return;
    }

    this.#desktopLeftInset = normalizedInset;
    this.#applyCameraViewportOffset();
    this.#frameSceneIfNeeded();
  }

  sync(state: TopologyStoreState): void {
    this.#state = state;
    const visibleDevices = state.snapshot.devices.filter((device) =>
      state.model.sceneDeviceIds.has(device.id)
    );
    const visibleDeviceSet = new Set(visibleDevices.map((device) => device.id));
    const targetByDeviceId = this.#computeTargets(visibleDevices, state);
    this.#lastVisibleDeviceById = new Map(visibleDevices.map((device) => [device.id, device]));
    this.#lastTargetByDeviceId = new Map(
      Array.from(targetByDeviceId.entries(), ([deviceId, target]) => [deviceId, target.clone()])
    );

    if (visibleDevices.length === 0) {
      this.#framedScene = false;
      this.#lastFrameSignature = null;
    }

    for (const device of visibleDevices) {
      const target = targetByDeviceId.get(device.id) ?? new Vector3();
      const existing = this.#deviceGroups.get(device.id);
      if (!existing) {
        const group = this.#createDeviceGroup(device);
        const start = this.#positionCache.get(device.id) ?? target.clone();
        group.position.copy(start);
        group.userData.target.copy(target);
        this.#deviceGroups.set(device.id, group);
        this.#deviceRoot.add(group);
      } else {
        existing.userData.device = device;
        existing.userData.target.copy(target);
      }
    }

    for (const [deviceId, group] of Array.from(this.#deviceGroups.entries())) {
      if (!visibleDeviceSet.has(deviceId)) {
        this.#positionCache.set(deviceId, group.position.clone());
        this.#deviceRoot.remove(group);
        this.#deviceGroups.delete(deviceId);
      }
    }

    const visibleLinks = state.snapshot.links.filter((link) =>
      state.model.visibleLinkIds.has(link.id)
    );
    const parallelOffsets = computeParallelLinkOffsets(visibleLinks);
    for (const link of visibleLinks) {
      let group = this.#linkGroups.get(link.id);
      if (!group) {
        group = this.#createLinkGroup(link);
        this.#linkGroups.set(link.id, group);
        this.#linkRoot.add(group);
      }
      group.userData.link = link;
      group.userData.parallelOffset = parallelOffsets.get(link.id) ?? 0;
    }

    for (const [linkId, group] of Array.from(this.#linkGroups.entries())) {
      if (!state.model.visibleLinkIds.has(linkId)) {
        this.#linkRoot.remove(group);
        this.#linkGroups.delete(linkId);
      }
    }

    this.#frameSceneIfNeeded();
    this.#updateObjectStyles(state);
  }

  screenPointForDevice(deviceId: string): { x: number; y: number } | null {
    const anchor = this.screenAnchorForDevice(deviceId);
    if (!anchor || anchor.visibility !== 'visible') {
      return null;
    }
    return {
      x: anchor.x,
      y: anchor.y,
    };
  }

  screenAnchorForDevice(deviceId: string): DeviceScreenAnchor | null {
    const group = this.#deviceGroups.get(deviceId);
    if (!group) {
      return null;
    }

    this.#camera.updateMatrixWorld();
    group.updateMatrixWorld(true);

    const worldPosition = new Vector3();
    group.getWorldPosition(worldPosition);

    const projected = worldPosition.clone().project(this.#camera);
    const cameraSpacePosition = worldPosition.clone().applyMatrix4(this.#camera.matrixWorldInverse);
    const isBehind = cameraSpacePosition.z >= 0;
    const isVisible =
      !isBehind &&
      projected.x >= -1 &&
      projected.x <= 1 &&
      projected.y >= -1 &&
      projected.y <= 1 &&
      projected.z >= -1 &&
      projected.z <= 1;

    let normalizedX = projected.x;
    let normalizedY = projected.y;
    let visibility: DeviceScreenAnchor['visibility'] = 'visible';

    if (!isVisible) {
      visibility = isBehind ? 'behind' : 'offscreen';
      if (isBehind) {
        normalizedX = -normalizedX;
        normalizedY = -normalizedY;
      }

      if (Math.abs(normalizedX) < 0.0001 && Math.abs(normalizedY) < 0.0001) {
        normalizedY = 1;
      }

      const magnitude = Math.max(Math.abs(normalizedX), Math.abs(normalizedY), 0.0001);
      normalizedX /= magnitude;
      normalizedY /= magnitude;
    }

    const rect = this.#renderer.domElement.getBoundingClientRect();
    return {
      x: ((normalizedX + 1) / 2) * rect.width,
      y: ((-normalizedY + 1) / 2) * rect.height,
      visibility,
    };
  }

  #installScene(): void {
    this.#scene.background = null;
    this.#camera.position.set(0, 18, 34);

    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.domElement.style.width = '100%';
    this.#renderer.domElement.style.height = '100%';
    this.#renderer.domElement.style.display = 'block';
    this.#renderer.domElement.style.background = 'transparent';
    this.#host.appendChild(this.#renderer.domElement);

    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.08;
    this.#controls.minDistance = 8;
    this.#controls.maxDistance = 220;
    this.#controls.target.set(0, 0, 0);

    const ambient = new HemisphereLight(0xffffff, 0xe5ecf6, 2.2);
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-20, 24, 18);
    const fill = new DirectionalLight(0xe5f0ff, 0.72);
    fill.position.set(18, -10, 12);
    this.#scene.add(ambient, key, fill, this.#linkRoot, this.#deviceRoot);

    this.#renderer.domElement.addEventListener('pointerdown', this.#handlePointerDown);
    this.#renderer.domElement.addEventListener('pointermove', this.#handlePointerMove);
    this.#renderer.domElement.addEventListener('pointerup', this.#handlePointerUp);
    this.#renderer.domElement.addEventListener('pointercancel', this.#handlePointerCancel);
    this.#renderer.domElement.addEventListener('pointerleave', this.#handlePointerLeave);
    this.#renderer.domElement.addEventListener('click', this.#handlePointerClick);
    window.addEventListener('resize', this.#resize);

    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#resize());
      this.#resizeObserver.observe(this.#host);
    }

    this.#resize();
    this.#animate();
  }

  #resize = (): void => {
    const { width, height } = this.#host.getBoundingClientRect();
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    this.#renderer.setSize(safeWidth, safeHeight, false);
    this.#applyCameraViewportOffset(safeWidth, safeHeight);
    this.#frameSceneIfNeeded();
  };

  #handlePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    this.#primaryPointerId = event.pointerId;
    this.#pointerDownPosition = {
      x: event.clientX,
      y: event.clientY,
    };
    this.#sceneDragInProgress = false;
  };

  #handlePointerMove = (event: PointerEvent): void => {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#hoverPointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

    if (this.#shouldStartRotationDrag(event)) {
      this.#sceneDragInProgress = true;
      if (this.#state?.hoverSource === 'scene') {
        this.#onClearHover();
      }
    }

    if (this.#sceneDragInProgress) {
      return;
    }

    const hits = this.#collectScenePointerHits();
    if (hits.deviceId) {
      this.#onHoverTarget({ deviceId: hits.deviceId, kind: 'device' }, this.#hoverPointer);
      return;
    }
    if (hits.linkId) {
      this.#onHoverTarget({ kind: 'link', linkId: hits.linkId }, this.#hoverPointer);
      return;
    }

    if (this.#state?.hoverSource === 'scene') {
      this.#onClearHover();
    }
  };

  #handlePointerLeave = (): void => {
    if (this.#state?.hoverSource === 'scene') {
      this.#onClearHover();
    }
  };

  #handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#primaryPointerId) {
      return;
    }

    if (this.#sceneDragInProgress) {
      this.#suppressNextClick = true;
    }

    this.#primaryPointerId = null;
    this.#pointerDownPosition = null;
    this.#sceneDragInProgress = false;
  };

  #handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.#primaryPointerId) {
      return;
    }

    this.#primaryPointerId = null;
    this.#pointerDownPosition = null;
    this.#sceneDragInProgress = false;
  };

  #handlePointerClick = (event: MouseEvent): void => {
    if (this.#suppressNextClick) {
      this.#suppressNextClick = false;
      return;
    }

    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const hits = this.#collectScenePointerHits();
    if (hits.deviceId) {
      this.#onSelectDevice(hits.deviceId);
    }
  };

  #shouldStartRotationDrag(event: PointerEvent): boolean {
    if (this.#sceneDragInProgress) {
      return false;
    }
    if (event.pointerId !== this.#primaryPointerId || !this.#pointerDownPosition) {
      return false;
    }

    const deltaX = event.clientX - this.#pointerDownPosition.x;
    const deltaY = event.clientY - this.#pointerDownPosition.y;
    return Math.hypot(deltaX, deltaY) >= ROTATION_DRAG_THRESHOLD_PX;
  }

  #collectScenePointerHits(): { deviceId: string | null; linkId: string | null } {
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    let deviceId: string | null = null;
    let linkId: string | null = null;

    for (const intersection of this.#raycaster.intersectObjects(this.#scenePickables(), true)) {
      const resolved = this.#resolveSceneIntersection(intersection.object);
      if (!resolved) {
        continue;
      }
      if (resolved.kind === 'device' && !deviceId) {
        deviceId = resolved.deviceId;
      }
      if (resolved.kind === 'link' && !linkId) {
        linkId = resolved.linkId;
      }
      if (deviceId && linkId) {
        break;
      }
    }

    return { deviceId, linkId };
  }

  #scenePickables(): Object3D[] {
    return [
      ...Array.from(this.#deviceGroups.values()).map((group) => group.userData.mesh),
      ...Array.from(this.#linkGroups.values())
        .map((group) => group.userData.hitMesh)
        .filter((mesh) => mesh.visible),
    ];
  }

  #resolveSceneIntersection(
    object: Object3D
  ): { deviceId: string; kind: 'device' } | { kind: 'link'; linkId: string } | null {
    const role = object.userData.role;
    if (role === 'device-mesh') {
      const group = this.#findAncestorByKind(object, 'device') as DeviceGroup | null;
      return group?.userData?.deviceId ? { deviceId: group.userData.deviceId, kind: 'device' } : null;
    }
    if (role === 'link-hit') {
      const group = this.#findAncestorByKind(object, 'link') as LinkGroup | null;
      return group?.userData?.linkId ? { kind: 'link', linkId: group.userData.linkId } : null;
    }
    return null;
  }

  #findAncestorByKind(object: Object3D | null, kind: 'device' | 'link'): Object3D | null {
    let current = object;
    while (current) {
      if (current.userData?.kind === kind) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  #animate = (): void => {
    this.#frameHandle = window.requestAnimationFrame(this.#animate);

    for (const group of this.#deviceGroups.values()) {
      const target = group.userData.target;
      group.position.lerp(target, 0.12);
      if (group.position.distanceTo(target) < 0.01) {
        group.position.copy(target);
      }
    }

    this.#controls.update();
    this.#updateLinkGeometry(performance.now() * 0.001);
    this.#renderer.render(this.#scene, this.#camera);
  };

  #updateLinkGeometry(elapsedSeconds: number): void {
    const cameraPosition = new Vector3();
    cameraPosition.setFromMatrixPosition(this.#camera.matrixWorld);
    const burstState = computeBurstState(elapsedSeconds);
    const tailShape = burstState.visible ? computeTailShape() : null;

    for (const group of this.#linkGroups.values()) {
      const link = group.userData.link;
      const local = this.#deviceGroups.get(link.local_device_id);
      const remote = this.#deviceGroups.get(link.remote_device_id);
      if (!local || !remote) {
        continue;
      }

      const runtime = group.userData.runtime;
      if (
        !computeLinkFrame(
          runtime,
          local.position,
          remote.position,
          cameraPosition,
          group.userData.parallelOffset
        )
      ) {
        continue;
      }

      this.#applyLinkRenderOrder(group, cameraPosition, runtime.center);
      placeRibbonMesh(
        group.userData.surface,
        runtime.localEnd,
        runtime.remoteEnd,
        runtime.normal,
        BASE_LINK_STYLE.outlineWidth
      );

      if (group.userData.hoverBand.visible) {
        placeRibbonMesh(
          group.userData.hoverBand,
          runtime.localEnd,
          runtime.remoteEnd,
          runtime.normal,
          BASE_LINK_STYLE.outlineWidth
        );
      }

      this.#placeLinkHitMesh(group.userData.hitMesh, runtime.localEnd, runtime.remoteEnd);
      this.#updateTrafficVisuals(group, runtime, burstState, tailShape);
    }
  }

  #computeTargets(
    devices: ViewDevice[],
    state: TopologyStoreState
  ): Map<string, Vector3> {
    if (devices.length === 0) {
      return new Map();
    }

    const visibleIds = new Set(devices.map((device) => device.id));
    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const layoutGraph = buildRelationLayoutGraph(visibleIds, {
      childIdsByDeviceId: state.model.childIdsByDeviceId,
      deviceById: state.model.deviceById,
      parentIdsByDeviceId: state.model.parentIdsByDeviceId,
      peerIdsByDeviceId: state.model.peerIdsByDeviceId,
      primaryChildrenByDeviceId: state.model.primaryChildrenByDeviceId,
      primaryParentDeviceById: state.model.primaryParentDeviceById,
      rootDeviceIds: state.model.rootDeviceIds,
    });
    const childrenByDeviceId = layoutGraph.childIdsByDeviceId;
    const parentsByDeviceId = layoutGraph.parentIdsByDeviceId;
    const roots = layoutGraph.rootDeviceIds;
    const rootSet = new Set(roots);

    const depthSpacing = 5.6;
    const slotSpacing = 2.8;
    const groupRingStart = 1.7;
    const groupRingStep = 1.7;
    const relaxIterations = 10;
    const maxStep = 0.22;
    const anchorByDeviceId = new Map<string, Vector3>();

    const placeConcentricGroup = (
      deviceIds: string[],
      center: Vector3,
      targetY: number,
      seedKey: string,
      innerRadius: number,
      radiusStep: number
    ) => {
      let cursor = 0;
      let ringIndex = 0;

      while (cursor < deviceIds.length) {
        const baseRadius = innerRadius + ringIndex * radiusStep;
        const capacity = Math.max(6, Math.floor((Math.PI * 2 * baseRadius) / slotSpacing));
        const ringIds = deviceIds.slice(cursor, cursor + capacity);
        const startAngle = hash01(`${seedKey}:ring:${ringIndex}`) * Math.PI * 2;
        const angleStep = ringIds.length > 0 ? (Math.PI * 2) / ringIds.length : 0;

        for (let index = 0; index < ringIds.length; index += 1) {
          const deviceId = ringIds[index];
          const childIds = childrenByDeviceId.get(deviceId) ?? [];
          const radius = baseRadius + (childIds.length > 0 ? 0.55 : 0);
          const angle = startAngle + index * angleStep;
          anchorByDeviceId.set(
            deviceId,
            new Vector3(
              center.x + Math.cos(angle) * radius,
              targetY,
              center.z + Math.sin(angle) * radius
            )
          );
        }

        cursor += ringIds.length;
        ringIndex += 1;
      }
    };
    const rootAnchors = buildRelationRootAnchors(layoutGraph);
    for (const [deviceId, anchor] of rootAnchors.entries()) {
      anchorByDeviceId.set(deviceId, anchor.clone());
    }

    const devicesByDepth = new Map<number, string[]>();
    for (const [deviceId, depth] of layoutGraph.depthByDeviceId.entries()) {
      if (depth <= 0) {
        continue;
      }
      const current = devicesByDepth.get(depth) ?? [];
      current.push(deviceId);
      devicesByDepth.set(depth, current);
    }

    const sortedDepths = Array.from(devicesByDepth.keys()).sort((left, right) => left - right);
    for (const depth of sortedDepths) {
      const layerIds = devicesByDepth.get(depth) ?? [];
      const groups = new Map<string, { center: Vector3; deviceIds: string[] }>();

      for (const deviceId of layerIds) {
        const parentIds = parentsByDeviceId.get(deviceId) ?? [];
        const parentAnchors = parentIds
          .map((parentId) => anchorByDeviceId.get(parentId))
          .filter((anchor): anchor is Vector3 => Boolean(anchor));

        const rootShares = layoutGraph.rootShareByDeviceId.get(deviceId) ?? new Map();
        const weightedRootCenter = new Vector3();
        let weightedTotal = 0;
        for (const [rootId, share] of rootShares.entries()) {
          const rootAnchor = rootAnchors.get(rootId);
          if (!rootAnchor) {
            continue;
          }
          weightedRootCenter.add(rootAnchor.clone().multiplyScalar(share));
          weightedTotal += share;
        }
        if (weightedTotal > 0) {
          weightedRootCenter.divideScalar(weightedTotal);
        }

        const parentCenter = new Vector3();
        if (parentAnchors.length > 0) {
          for (const anchor of parentAnchors) {
            parentCenter.add(anchor);
          }
          parentCenter.divideScalar(parentAnchors.length);
        } else {
          parentCenter.copy(weightedRootCenter);
        }

        const center =
          weightedTotal > 0 && parentAnchors.length > 0
            ? parentCenter.clone().lerp(weightedRootCenter, 0.25)
            : parentCenter.clone();
        center.y = -depth * depthSpacing;

        const signatureParts = [
          `depth:${depth}`,
          `parents:${parentIds.join('|')}`,
          `roots:${Array.from(rootShares.keys()).sort().join('|')}`,
        ];
        const signature = signatureParts.join('::');
        const group = groups.get(signature) ?? { center: new Vector3(), deviceIds: [] };
        group.center.add(center);
        group.deviceIds.push(deviceId);
        groups.set(signature, group);
      }

      const sortedGroups = Array.from(groups.entries()).sort(([leftKey], [rightKey]) =>
        leftKey.localeCompare(rightKey)
      );
      for (const [signature, group] of sortedGroups) {
        group.center.divideScalar(Math.max(group.deviceIds.length, 1));
        group.deviceIds.sort((leftId, rightId) =>
          `${deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
            `${deviceById.get(rightId)?.label ?? rightId}`
          )
        );

        if (group.deviceIds.length === 1) {
          anchorByDeviceId.set(group.deviceIds[0], group.center.clone());
          continue;
        }

        placeConcentricGroup(
          group.deviceIds,
          group.center,
          group.center.y,
          signature,
          groupRingStart,
          groupRingStep
        );
      }
    }

    const orderedIds = devices.map((device) => device.id).sort((leftId, rightId) => leftId.localeCompare(rightId));
    const positions = new Map(
      Array.from(anchorByDeviceId.entries(), ([deviceId, anchor]) => [deviceId, anchor.clone()])
    );

    for (let iteration = 0; iteration < relaxIterations; iteration += 1) {
      const forces = new Map(orderedIds.map((deviceId) => [deviceId, { x: 0, z: 0 }]));

      for (let leftIndex = 0; leftIndex < orderedIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < orderedIds.length; rightIndex += 1) {
          const leftId = orderedIds[leftIndex];
          const rightId = orderedIds[rightIndex];
          const leftPosition = positions.get(leftId);
          const rightPosition = positions.get(rightId);
          if (!leftPosition || !rightPosition) {
            continue;
          }

          let dx = rightPosition.x - leftPosition.x;
          let dz = rightPosition.z - leftPosition.z;
          let distance = Math.hypot(dx, dz);
          if (distance < 0.0001) {
            const angle = hash01(`layout:${pairKey(leftId, rightId)}`) * Math.PI * 2;
            dx = Math.cos(angle) * 0.001;
            dz = Math.sin(angle) * 0.001;
            distance = 0.001;
          }

          const minDistance =
            layoutRadiusForDevice(deviceById.get(leftId)) +
            layoutRadiusForDevice(deviceById.get(rightId)) +
            0.55;
          if (distance >= minDistance) {
            continue;
          }

          const normalized = (minDistance - distance) / minDistance;
          const strength = 0.18 * normalized;
          const unitX = dx / distance;
          const unitZ = dz / distance;
          const leftForce = forces.get(leftId);
          const rightForce = forces.get(rightId);
          if (!leftForce || !rightForce) {
            continue;
          }
          leftForce.x -= unitX * strength;
          leftForce.z -= unitZ * strength;
          rightForce.x += unitX * strength;
          rightForce.z += unitZ * strength;
        }
      }

      for (const deviceId of orderedIds) {
        const anchor = anchorByDeviceId.get(deviceId);
        const position = positions.get(deviceId);
        const force = forces.get(deviceId);
        if (!anchor || !position || !force) {
          continue;
        }
        const anchorStrength = rootSet.has(deviceId) ? 0.24 : 0.18;
        force.x += (anchor.x - position.x) * anchorStrength;
        force.z += (anchor.z - position.z) * anchorStrength;
      }

      for (const deviceId of orderedIds) {
        const position = positions.get(deviceId);
        const force = forces.get(deviceId);
        if (!position || !force) {
          continue;
        }
        position.x += clampMagnitude(force.x, maxStep);
        position.z += clampMagnitude(force.z, maxStep);
      }
    }

    recenterPositionsAroundRootCentroid(positions, roots);

    return new Map(
      Array.from(positions.entries(), ([deviceId, position]) => {
        const anchor = anchorByDeviceId.get(deviceId) ?? position;
        return [deviceId, new Vector3(position.x, anchor.y, position.z)];
      })
    );
  }

  #computeCentroid(targetByDeviceId: Map<string, Vector3>): Vector3 {
    const centroid = new Vector3();
    if (targetByDeviceId.size === 0) {
      return centroid;
    }
    for (const target of targetByDeviceId.values()) {
      centroid.add(target);
    }
    centroid.divideScalar(targetByDeviceId.size);
    return centroid;
  }

  #computeBounds(targetByDeviceId: Map<string, Vector3>): {
    max: Vector3;
    min: Vector3;
  } {
    if (targetByDeviceId.size === 0) {
      return { max: new Vector3(), min: new Vector3() };
    }

    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const [deviceId, target] of targetByDeviceId.entries()) {
      const device = this.#lastVisibleDeviceById.get(deviceId);
      const padding = layoutRadiusForDevice(device) * 0.72;
      min.min(new Vector3(target.x - padding, target.y - padding, target.z - padding));
      max.max(new Vector3(target.x + padding, target.y + padding, target.z + padding));
    }
    return { max, min };
  }

  #currentRenderSize(): { height: number; width: number } {
    const rect = this.#host.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
    };
  }

  #effectiveVisibleWidth(width: number): number {
    return Math.max(width * 0.35, width - this.#desktopLeftInset);
  }

  #projectionInset(): number {
    return projectionInsetFromDesktopInset(this.#desktopLeftInset);
  }

  #applyCameraViewportOffset(width?: number, height?: number): void {
    const renderSize = width && height ? { width, height } : this.#currentRenderSize();
    const projectionInset = this.#projectionInset();

    if (projectionInset > 0.5) {
      const fullWidth = renderSize.width + projectionInset;
      this.#camera.aspect = fullWidth / renderSize.height;
      this.#camera.setViewOffset(fullWidth, renderSize.height, 0, 0, renderSize.width, renderSize.height);
    } else {
      this.#camera.clearViewOffset();
      this.#camera.aspect = renderSize.width / renderSize.height;
    }
    this.#camera.updateProjectionMatrix();
  }

  #frameSceneIfNeeded(): void {
    if (this.#lastTargetByDeviceId.size === 0 || this.#lastVisibleDeviceById.size === 0) {
      return;
    }

    const renderSize = this.#currentRenderSize();
    const bounds = this.#computeBounds(this.#lastTargetByDeviceId);
    const deviceSignature = Array.from(this.#lastVisibleDeviceById.keys()).sort().join('|');
    const boundsSignature = [
      bounds.min.x,
      bounds.min.y,
      bounds.min.z,
      bounds.max.x,
      bounds.max.y,
      bounds.max.z,
    ]
      .map((value) => value.toFixed(2))
      .join('|');
    const frameSignature = [
      deviceSignature,
      boundsSignature,
      renderSize.width,
      renderSize.height,
      this.#desktopLeftInset.toFixed(1),
      this.#projectionInset().toFixed(1),
    ].join('::');

    if (this.#framedScene && this.#lastFrameSignature === frameSignature) {
      return;
    }

    this.#frameScene(bounds, renderSize.width, renderSize.height);
    this.#lastFrameSignature = frameSignature;
    this.#framedScene = true;
  }

  #frameScene(
    bounds: {
      max: Vector3;
      min: Vector3;
    },
    renderWidth: number,
    renderHeight: number
  ): void {
    const center = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
    const offsetDirection = new Vector3(0.42, 0.68, 0.86).normalize();
    const forward = offsetDirection.clone().multiplyScalar(-1);
    const worldUp = new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(worldUp, forward).normalize();
    const up = new Vector3().crossVectors(forward, right).normalize();
    const verticalFov = (this.#camera.fov * Math.PI) / 180;
    const horizontalFov =
      2 * Math.atan(Math.tan(verticalFov / 2) * (this.#effectiveVisibleWidth(renderWidth) / renderHeight));
    const corners = this.#boundsCorners(bounds);

    let horizontalExtent = 0;
    let verticalExtent = 0;
    let depthExtent = 0;
    for (const corner of corners) {
      const relative = corner.clone().sub(center);
      horizontalExtent = Math.max(horizontalExtent, Math.abs(relative.dot(right)));
      verticalExtent = Math.max(verticalExtent, Math.abs(relative.dot(up)));
      depthExtent = Math.max(depthExtent, Math.abs(relative.dot(forward)));
    }

    const fitDistance = Math.max(
      horizontalExtent / Math.tan(horizontalFov / 2),
      verticalExtent / Math.tan(verticalFov / 2),
      12
    );
    const distance = fitDistance + depthExtent + 3.5;

    this.#controls.target.copy(center);
    this.#camera.position.copy(center.clone().add(offsetDirection.multiplyScalar(distance)));
    this.#camera.lookAt(center);
  }

  #boundsCorners(bounds: { max: Vector3; min: Vector3 }): Vector3[] {
    const { min, max } = bounds;
    return [
      new Vector3(min.x, min.y, min.z),
      new Vector3(min.x, min.y, max.z),
      new Vector3(min.x, max.y, min.z),
      new Vector3(min.x, max.y, max.z),
      new Vector3(max.x, min.y, min.z),
      new Vector3(max.x, min.y, max.z),
      new Vector3(max.x, max.y, min.z),
      new Vector3(max.x, max.y, max.z),
    ];
  }

  #createDeviceGroup(device: ViewDevice): DeviceGroup {
    const group = new Group() as DeviceGroup;
    const geometry = this.#createDeviceGeometry(device);
    const material = new MeshStandardMaterial({
      color: deploymentColor(device.deployment_type),
      emissive: 0x000000,
      flatShading: true,
      metalness: 0.08,
      roughness: 0.38,
    });

    const mesh = new Mesh(geometry, material);
    mesh.userData.role = 'device-mesh';
    group.add(mesh);

    const edges = new LineSegments(
      new EdgesGeometry(geometry, 18),
      new LineBasicMaterial({
        color: 0x20324d,
        opacity: 0.36,
        transparent: true,
      })
    );
    edges.userData.role = 'device-edges';
    group.add(edges);

    group.userData = {
      device,
      deviceId: device.id,
      edges,
      kind: 'device',
      material,
      mesh,
      target: new Vector3(),
    };

    return group;
  }

  #createDeviceGeometry(device: ViewDevice): BufferGeometry {
    const spec = deviceVisualSpec(device);
    switch (spec.shape.kind) {
      case 'box':
        return new BoxGeometry(spec.shape.width, spec.shape.height, spec.shape.depth);
      case 'cylinder':
        return new CylinderGeometry(
          spec.shape.radiusTop,
          spec.shape.radiusBottom,
          spec.shape.height,
          spec.shape.radialSegments
        );
      default:
        return new IcosahedronGeometry(spec.shape.radius, spec.shape.detail);
    }
  }

  #createLinkGroup(link: ViewLink): LinkGroup {
    const group = new Group() as LinkGroup;
    const surface = createLinkSurfaceMesh();
    surface.userData.role = 'link-surface';
    const hoverBand = createHoverBandMesh();
    hoverBand.userData.role = 'link-hover-band';
    const linkGlow = createLinkGlowMesh(0xffffff);
    const forwardTrail = createTrafficTrailMesh(0xffffff, 0xffffff);
    const backwardTrail = createTrafficTrailMesh(0xffffff, 0xffffff);
    const forwardHeadGlow = createHeadSprite(0xffffff, TRAFFIC_VARIANT.headScale * TRAFFIC_GLOW_STYLE.headScaleMultiplier);
    const backwardHeadGlow = createHeadSprite(0xffffff, TRAFFIC_VARIANT.headScale * TRAFFIC_GLOW_STYLE.headScaleMultiplier);
    const forwardHead = createHeadSprite(0xffffff, TRAFFIC_VARIANT.headScale);
    const backwardHead = createHeadSprite(0xffffff, TRAFFIC_VARIANT.headScale);

    const hitMesh = new Mesh(
      new CylinderGeometry(0.12, 0.12, 1, 16, 1, true),
      new MeshBasicMaterial({
        color: 0xffffff,
        depthWrite: false,
        opacity: 0,
        transparent: true,
      })
    );
    hitMesh.userData.role = 'link-hit';
    group.add(
      surface,
      hoverBand,
      linkGlow,
      forwardTrail,
      backwardTrail,
      forwardHeadGlow,
      backwardHeadGlow,
      forwardHead,
      backwardHead,
      hitMesh
    );

    group.userData = {
      backwardHead,
      backwardHeadGlow,
      backwardTrail,
      forwardHead,
      forwardHeadGlow,
      forwardTrail,
      hoverBand,
      hitMesh,
      kind: 'link',
      lastSurfaceKey: '',
      link,
      linkGlow,
      linkId: link.id,
      parallelOffset: 0,
      runtime: createLinkRuntimeState(),
      surface,
      visualState: {
        animate: false,
        bandColor: 0x4b5563,
        bandOpacity: BASE_LINK_STYLE.bandOpacity,
        dimmed: false,
        fillColor: 0x64748b,
        fillOpacity: BASE_LINK_STYLE.ribbonOpacity,
        hoverBandVisible: false,
        linkGlowColor: 0xffffff,
        trafficColor: 0xffffff,
      },
    };

    return group;
  }

  #isGuestAccessLink(link: ViewLink): boolean {
    return (
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment?.vlan_tag !== undefined
    );
  }

  #isGuestTrunkLink(link: ViewLink): boolean {
    return (
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment?.vlan_tag === undefined &&
      Array.isArray(link.guest_attachment?.trunk_vlans) &&
      link.guest_attachment.trunk_vlans.length > 0
    );
  }

  #baseLinkColor(link: ViewLink): number {
    if (this.#isGuestTrunkLink(link)) {
      return 0x4b5563;
    }
    const networkColor = networkCidrColor(primaryNetworkCidr(link));
    if (networkColor !== null) {
      return networkColor;
    }
    return 0x4b5563;
  }

  #pathHighlightColorForLink(
    link: ViewLink,
    state: TopologyStoreState
  ): number | null {
    for (const pathState of [state.hoveredPath, state.selectedPath]) {
      const resolvedNetworkCidr = pathState.resolvedNetworkCidrByLink[link.id];
      const resolvedColor = networkCidrColor(resolvedNetworkCidr);
      if (resolvedColor !== null) {
        return resolvedColor;
      }
    }
    return null;
  }

  #highlightedGuestLinkIds(state: TopologyStoreState): Set<string> {
    const highlighted = new Set<string>();
    for (const pathState of [state.hoveredPath, state.selectedPath]) {
      const highlight = pathState.guestHighlight;
      if (!highlight) {
        continue;
      }
      highlighted.add(highlight.accessLinkId);
      if (highlight.trunkLinkId) {
        highlighted.add(highlight.trunkLinkId);
      }
    }
    return highlighted;
  }

  #dimmedParallelGuestLinkIds(state: TopologyStoreState): Set<string> {
    const highlightedLinkIds = this.#highlightedGuestLinkIds(state);
    const highlightedPairKeys = new Set<string>();

    for (const linkId of highlightedLinkIds) {
      const link = state.snapshot.links.find((candidate) => candidate.id === linkId);
      if (!link || link.protocol !== 'proxmox_guest_link') {
        continue;
      }
      highlightedPairKeys.add(this.#devicePairKeyForLink(link));
    }

    if (highlightedPairKeys.size === 0) {
      return new Set();
    }

    return new Set(
      state.snapshot.links
        .filter(
          (link) =>
            link.protocol === 'proxmox_guest_link' &&
            !highlightedLinkIds.has(link.id) &&
            highlightedPairKeys.has(this.#devicePairKeyForLink(link))
        )
        .map((link) => link.id)
    );
  }

  #updateObjectStyles(state: TopologyStoreState): void {
    const dimmedLinkIds = this.#dimmedParallelGuestLinkIds(state);

    for (const [deviceId, group] of this.#deviceGroups) {
      const isSelected = deviceId === state.selectedDeviceId;
      const isHovered = deviceId === state.hoveredDeviceId;
      const onSelectedPath = state.selectedPath.deviceIds.has(deviceId) && !isSelected;
      const onHoveredPath =
        state.hoveredPath.deviceIds.has(deviceId) && !isSelected && !isHovered;

      const scale = isSelected ? 1.16 : isHovered ? 1.1 : onSelectedPath ? 1.06 : onHoveredPath ? 1.03 : 1;
      group.scale.setScalar(scale);
      group.userData.material.emissive.setHex(
        isSelected ? 0x123b88 : isHovered ? 0x7c2d12 : onSelectedPath ? 0x09368f : 0x000000
      );
      (group.userData.edges.material as LineBasicMaterial).opacity =
        isSelected || isHovered || onSelectedPath ? 0.62 : 0.36;
      (group.userData.edges.material as LineBasicMaterial).color.setHex(
        isHovered ? 0xd97706 : isSelected || onSelectedPath ? 0x0f62fe : 0x20324d
      );
      group.userData.material.roughness = isSelected || isHovered ? 0.28 : 0.38;
      group.userData.material.color.setHex(deploymentColor(group.userData.device.deployment_type));
    }

    for (const group of this.#linkGroups.values()) {
      this.#applyLinkStyle(group, state, dimmedLinkIds);
    }
  }

  #applyLinkStyle(group: LinkGroup, state: TopologyStoreState, dimmedLinkIds: Set<string>): void {
    const link = group.userData.link;
    const isHoveredLink = link.id === state.hoveredLinkId;
    const isOnHoveredPath = !isHoveredLink && state.hoveredPath.linkIds.has(link.id);
    const isOnSelectedPath =
      !isHoveredLink &&
      !isOnHoveredPath &&
      state.selectedPath.linkIds.has(link.id);
    const guestHighlightColor = this.#pathHighlightColorForLink(link, state);
    const baseColor = this.#baseLinkColor(link);
    const activeColor = guestHighlightColor ?? baseColor;
    const fillColor = isOnHoveredPath || isOnSelectedPath ? mixColor(activeColor, 0xffffff, 0.08) : baseColor;
    const dimmed = dimmedLinkIds.has(link.id);
    const fillOpacity = (isOnHoveredPath || isOnSelectedPath ? 1 : BASE_LINK_STYLE.ribbonOpacity) * (dimmed ? 0.34 : 1);
    const bandOpacity = (isHoveredLink ? 0.36 : BASE_LINK_STYLE.bandOpacity) * (dimmed ? 0.34 : 1);
    const visualState: LinkVisualState = {
      animate: isOnHoveredPath || isOnSelectedPath,
      bandColor: darkenColor(activeColor, 0.58),
      bandOpacity,
      dimmed,
      fillColor,
      fillOpacity,
      hoverBandVisible: isHoveredLink,
      linkGlowColor: mixColor(activeColor, 0xffffff, 0.48),
      trafficColor: mixColor(activeColor, 0xffffff, TRAFFIC_VARIANT.tintMix),
    };
    group.userData.visualState = visualState;

    const surfaceKey = [
      visualState.animate ? 1 : 0,
      visualState.hoverBandVisible ? 1 : 0,
      visualState.fillColor.toString(16),
      visualState.bandColor.toString(16),
      visualState.fillOpacity.toFixed(3),
      visualState.bandOpacity.toFixed(3),
    ].join(':');
    if (surfaceKey !== group.userData.lastSurfaceKey) {
      this.#applySurfaceUniforms(group.userData.surface.material as ShaderMaterial, visualState);
      this.#applyHoverBandUniforms(group.userData.hoverBand.material as ShaderMaterial);
      this.#applyTrafficPalette(group);
      group.userData.lastSurfaceKey = surfaceKey;
    }

    group.userData.surface.visible = true;
    group.userData.hoverBand.visible = visualState.hoverBandVisible;
    group.userData.hitMesh.visible = true;
  }

  #applySurfaceUniforms(material: ShaderMaterial, visualState: LinkVisualState): void {
    material.uniforms.uBandColor.value.setHex(visualState.bandColor);
    material.uniforms.uBandOpacity.value = visualState.bandOpacity;
    material.uniforms.uFillColor.value.setHex(visualState.fillColor);
    material.uniforms.uFillOpacity.value = visualState.fillOpacity;
  }

  #applyHoverBandUniforms(material: ShaderMaterial): void {
    material.uniforms.uBandColor.value.setHex(HOVER_BAND_STYLE.color);
    material.uniforms.uBandOpacity.value = HOVER_BAND_STYLE.opacity;
  }

  #applyTrafficPalette(group: LinkGroup): void {
    const { visualState } = group.userData;
    const glowColor = mixColor(visualState.trafficColor, 0xffffff, 0.62);

    (group.userData.linkGlow.material as ShaderMaterial).uniforms.uGlowColor.value.setHex(visualState.linkGlowColor);
    for (const trail of [group.userData.forwardTrail, group.userData.backwardTrail]) {
      const uniforms = (trail.material as ShaderMaterial).uniforms;
      uniforms.uCoreColor.value.setHex(visualState.trafficColor);
      uniforms.uGlowColor.value.setHex(glowColor);
    }
    for (const sprite of [
      group.userData.forwardHead,
      group.userData.backwardHead,
      group.userData.forwardHeadGlow,
      group.userData.backwardHeadGlow,
    ]) {
      const isGlow = sprite === group.userData.forwardHeadGlow || sprite === group.userData.backwardHeadGlow;
      (sprite.material as SpriteMaterial).color.setHex(isGlow ? glowColor : visualState.trafficColor);
    }
  }

  #placeLinkHitMesh(hitMesh: Mesh, start: Vector3, end: Vector3): void {
    const midpoint = start.clone().add(end).multiplyScalar(0.5);
    const direction = end.clone().sub(start);
    const length = Math.max(direction.length(), 0.001);
    direction.normalize();
    hitMesh.position.copy(midpoint);
    hitMesh.quaternion.setFromUnitVectors(WORLD_UP, direction);
    hitMesh.scale.set(1, length, 1);
  }

  #applyLinkRenderOrder(group: LinkGroup, cameraPosition: Vector3, center: Vector3): void {
    const baseOrder = -cameraPosition.distanceToSquared(center) * 100;
    group.userData.surface.renderOrder = baseOrder;
    group.userData.hoverBand.renderOrder = baseOrder + 0.5;
    group.userData.linkGlow.renderOrder = baseOrder + 1;
    group.userData.forwardTrail.renderOrder = baseOrder + 2;
    group.userData.backwardTrail.renderOrder = baseOrder + 2;
    group.userData.forwardHeadGlow.renderOrder = baseOrder + 3;
    group.userData.backwardHeadGlow.renderOrder = baseOrder + 3;
    group.userData.forwardHead.renderOrder = baseOrder + 4;
    group.userData.backwardHead.renderOrder = baseOrder + 4;
  }

  #updateTrafficVisuals(
    group: LinkGroup,
    runtime: LinkRuntimeState,
    burstState: BurstState,
    tailShape: TailShape | null
  ): void {
    const {
      backwardHead,
      backwardHeadGlow,
      backwardTrail,
      forwardHead,
      forwardHeadGlow,
      forwardTrail,
      linkGlow,
      visualState,
    } = group.userData;

    for (const visual of [
      linkGlow,
      forwardTrail,
      backwardTrail,
      forwardHead,
      backwardHead,
      forwardHeadGlow,
      backwardHeadGlow,
    ]) {
      visual.visible = false;
    }

    if (!visualState.animate || !burstState.visible || !tailShape) {
      return;
    }

    runtime.glowLift.copy(runtime.surfaceLift).multiplyScalar(0.22);
    runtime.localStart.copy(runtime.localEnd).add(runtime.surfaceLift);
    runtime.remoteStart.copy(runtime.remoteEnd).add(runtime.surfaceLift);
    runtime.localGlowStart.copy(runtime.localEnd).add(runtime.glowLift);
    runtime.remoteGlowStart.copy(runtime.remoteEnd).add(runtime.glowLift);

    if (
      !setPointAlongLink(runtime.forwardHeadPoint, runtime.localStart, runtime.remoteStart, burstState.headT) ||
      !setPointAlongLink(runtime.backwardHeadPoint, runtime.remoteStart, runtime.localStart, burstState.headT)
    ) {
      return;
    }

    placeRibbonMesh(
      linkGlow,
      runtime.localGlowStart,
      runtime.remoteGlowStart,
      runtime.normal,
      Number(linkGlow.userData.ribbonWidth)
    );
    const linkGlowUniforms = (linkGlow.material as ShaderMaterial).uniforms;
    linkGlowUniforms.uOpacity.value = LINK_GLOW_STYLE.opacity * burstState.opacity;
    linkGlowUniforms.uForwardHeadT.value = burstState.headT;
    linkGlowUniforms.uBackwardHeadT.value = 1 - burstState.headT;
    linkGlow.visible = true;

    const forwardVisible = setTrailingSegment(
      runtime.forwardSegment,
      runtime.localStart,
      runtime.remoteStart,
      burstState.headT,
      burstState.lengthT
    );
    const backwardVisible = setTrailingSegment(
      runtime.backwardSegment,
      runtime.remoteStart,
      runtime.localStart,
      burstState.headT,
      burstState.lengthT
    );

    if (forwardVisible) {
      placeRibbonMesh(
        forwardTrail,
        runtime.forwardSegment.start,
        runtime.forwardSegment.end,
        runtime.normal,
        Number(forwardTrail.userData.ribbonWidth)
      );
      this.#applyTrailUniforms(forwardTrail.material as ShaderMaterial, burstState.opacity, tailShape);
      forwardTrail.visible = true;
    }
    if (backwardVisible) {
      placeRibbonMesh(
        backwardTrail,
        runtime.backwardSegment.start,
        runtime.backwardSegment.end,
        runtime.normal,
        Number(backwardTrail.userData.ribbonWidth)
      );
      this.#applyTrailUniforms(backwardTrail.material as ShaderMaterial, burstState.opacity, tailShape);
      backwardTrail.visible = true;
    }

    forwardHead.position.copy(runtime.forwardHeadPoint);
    backwardHead.position.copy(runtime.backwardHeadPoint);
    forwardHeadGlow.position.copy(runtime.forwardHeadPoint);
    backwardHeadGlow.position.copy(runtime.backwardHeadPoint);

    const headOpacity = Math.min(1, burstState.opacity + TRAFFIC_VARIANT.headOpacityBoost);
    const headGlowOpacity = Math.min(1, headOpacity * TRAFFIC_GLOW_STYLE.headOpacityScale);
    (forwardHead.material as SpriteMaterial).opacity = headOpacity;
    (backwardHead.material as SpriteMaterial).opacity = headOpacity;
    (forwardHeadGlow.material as SpriteMaterial).opacity = headGlowOpacity;
    (backwardHeadGlow.material as SpriteMaterial).opacity = headGlowOpacity;
    forwardHead.visible = true;
    backwardHead.visible = true;
    forwardHeadGlow.visible = true;
    backwardHeadGlow.visible = true;
  }

  #applyTrailUniforms(material: ShaderMaterial, opacity: number, tailShape: TailShape): void {
    material.uniforms.uOpacity.value = opacity;
    material.uniforms.uCoreWidth.value = tailShape.coreWidth;
    material.uniforms.uDecayExponent.value = tailShape.decayExponent;
    material.uniforms.uGlowWidth.value = tailShape.glowWidth;
    material.uniforms.uGlowStrength.value = tailShape.glowStrength;
    material.uniforms.uRootReach.value = tailShape.rootReach;
    material.uniforms.uRootWidthScale.value = tailShape.rootWidthScale;
    material.uniforms.uTailFloor.value = tailShape.tailFloor;
    material.uniforms.uTipWidth.value = tailShape.tipWidth;
  }

  #devicePairKeyForLink(link: ViewLink): string {
    return pairKey(link.local_device_id, link.remote_device_id);
  }
}
