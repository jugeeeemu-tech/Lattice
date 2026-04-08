import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

import type { ViewLink } from '../../generated';
import type { TopologyStoreState } from '../../state/topology-store';
import { networkCidrColor, primaryNetworkCidr } from '../../topology/view-model';
import type { DeviceGroup, LinkGroup } from './types';
import type { LinkRuntimeState, LinkVisualState } from './types';

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

const SHARED_RIBBON_GEOMETRY = createSharedRibbonGeometry();
let TRAFFIC_HEAD_TEXTURE: CanvasTexture | null = null;
const RIBBON_TANGENT = new Vector3();
const RIBBON_BINORMAL = new Vector3();
const RIBBON_MATRIX = new Matrix4();

function pairKey(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
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
    new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3)
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

  const gradient = context.createRadialGradient(size * 0.5, size * 0.5, size * 0.08, size * 0.5, size * 0.5, size * 0.5);
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

export function createLinkGroup(link: ViewLink): LinkGroup {
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

function isGuestAccessLink(link: ViewLink): boolean {
  return link.protocol === 'proxmox_guest_link' && link.guest_attachment?.vlan_tag !== undefined;
}

function isGuestTrunkLink(link: ViewLink): boolean {
  return (
    link.protocol === 'proxmox_guest_link' &&
    link.guest_attachment?.vlan_tag === undefined &&
    Array.isArray(link.guest_attachment?.trunk_vlans) &&
    link.guest_attachment.trunk_vlans.length > 0
  );
}

function baseLinkColor(link: ViewLink): number {
  if (isGuestTrunkLink(link)) {
    return 0x4b5563;
  }
  const networkColor = networkCidrColor(primaryNetworkCidr(link));
  if (networkColor !== null) {
    return networkColor;
  }
  return 0x4b5563;
}

function pathHighlightColorForLink(link: ViewLink, state: TopologyStoreState): number | null {
  for (const pathState of [state.hoveredPath, state.selectedPath]) {
    const resolvedNetworkCidr = pathState.resolvedNetworkCidrByLink[link.id];
    const resolvedColor = networkCidrColor(resolvedNetworkCidr);
    if (resolvedColor !== null) {
      return resolvedColor;
    }
  }
  return null;
}

function highlightedGuestLinkIds(state: TopologyStoreState): Set<string> {
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

function devicePairKeyForLink(link: ViewLink): string {
  return pairKey(link.local_device_id, link.remote_device_id);
}

function dimmedParallelGuestLinkIds(state: TopologyStoreState): Set<string> {
  const highlightedLinkIds = highlightedGuestLinkIds(state);
  const highlightedPairKeys = new Set<string>();

  for (const linkId of highlightedLinkIds) {
    const link = state.snapshot.links.find((candidate) => candidate.id === linkId);
    if (!link || link.protocol !== 'proxmox_guest_link') {
      continue;
    }
    highlightedPairKeys.add(devicePairKeyForLink(link));
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
          highlightedPairKeys.has(devicePairKeyForLink(link))
      )
      .map((link) => link.id)
  );
}

function applySurfaceUniforms(material: ShaderMaterial, visualState: LinkVisualState): void {
  material.uniforms.uBandColor.value.setHex(visualState.bandColor);
  material.uniforms.uBandOpacity.value = visualState.bandOpacity;
  material.uniforms.uFillColor.value.setHex(visualState.fillColor);
  material.uniforms.uFillOpacity.value = visualState.fillOpacity;
}

function applyHoverBandUniforms(material: ShaderMaterial): void {
  material.uniforms.uBandColor.value.setHex(HOVER_BAND_STYLE.color);
  material.uniforms.uBandOpacity.value = HOVER_BAND_STYLE.opacity;
}

function applyTrafficPalette(group: LinkGroup): void {
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

function applyLinkStyle(group: LinkGroup, state: TopologyStoreState, dimmedLinkIds: Set<string>): void {
  const link = group.userData.link;
  const isHoveredLink = link.id === state.hoveredLinkId;
  const isOnHoveredPath = !isHoveredLink && state.hoveredPath.linkIds.has(link.id);
  const isOnSelectedPath = !isHoveredLink && !isOnHoveredPath && state.selectedPath.linkIds.has(link.id);
  const guestHighlightColor = pathHighlightColorForLink(link, state);
  const baseColor = baseLinkColor(link);
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
    applySurfaceUniforms(group.userData.surface.material as ShaderMaterial, visualState);
    applyHoverBandUniforms(group.userData.hoverBand.material as ShaderMaterial);
    applyTrafficPalette(group);
    group.userData.lastSurfaceKey = surfaceKey;
  }

  group.userData.surface.visible = true;
  group.userData.hoverBand.visible = visualState.hoverBandVisible;
  group.userData.hitMesh.visible = true;
}

export function updateLinkStyles(linkGroups: Iterable<LinkGroup>, state: TopologyStoreState): void {
  const dimmedLinkIds = dimmedParallelGuestLinkIds(state);
  for (const group of linkGroups) {
    applyLinkStyle(group, state, dimmedLinkIds);
  }
}

function placeLinkHitMesh(hitMesh: Mesh, start: Vector3, end: Vector3): void {
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const length = Math.max(direction.length(), 0.001);
  direction.normalize();
  hitMesh.position.copy(midpoint);
  hitMesh.quaternion.setFromUnitVectors(WORLD_UP, direction);
  hitMesh.scale.set(1, length, 1);
}

function applyLinkRenderOrder(group: LinkGroup, cameraPosition: Vector3, center: Vector3): void {
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

function applyTrailUniforms(material: ShaderMaterial, opacity: number, tailShape: TailShape): void {
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

function updateTrafficVisuals(
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
    applyTrailUniforms(forwardTrail.material as ShaderMaterial, burstState.opacity, tailShape);
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
    applyTrailUniforms(backwardTrail.material as ShaderMaterial, burstState.opacity, tailShape);
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

export function updateLinkGeometry(
  linkGroups: Iterable<LinkGroup>,
  deviceGroups: ReadonlyMap<string, DeviceGroup>,
  cameraPosition: Vector3,
  elapsedSeconds: number
): void {
  const burstState = computeBurstState(elapsedSeconds);
  const tailShape = burstState.visible ? computeTailShape() : null;

  for (const group of linkGroups) {
    const link = group.userData.link;
    const local = deviceGroups.get(link.local_device_id);
    const remote = deviceGroups.get(link.remote_device_id);
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

    applyLinkRenderOrder(group, cameraPosition, runtime.center);
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

    placeLinkHitMesh(group.userData.hitMesh, runtime.localEnd, runtime.remoteEnd);
    updateTrafficVisuals(group, runtime, burstState, tailShape);
  }
}

export function linkHitMeshes(linkGroups: Iterable<LinkGroup>): Mesh[] {
  return Array.from(linkGroups, (group) => group.userData.hitMesh).filter((mesh) => mesh.visible);
}

export function resolveLinkIntersection(object: Object3D): { kind: 'link'; linkId: string } | null {
  if (object.userData.role !== 'link-hit') {
    return null;
  }

  let current: Object3D | null = object;
  while (current) {
    if (current.userData?.kind === 'link') {
      const group = current as LinkGroup;
      return group.userData?.linkId ? { kind: 'link', linkId: group.userData.linkId } : null;
    }
    current = current.parent;
  }
  return null;
}
