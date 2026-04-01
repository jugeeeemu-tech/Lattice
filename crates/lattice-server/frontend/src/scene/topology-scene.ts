import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
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
  computeUpstreamPath,
  deploymentColor,
  guestAttachmentNetworkColor,
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
    hitMesh: Mesh;
    kind: 'link';
    line: Line<BufferGeometry, LineBasicMaterial | LineDashedMaterial>;
    link: ViewLink;
    linkId: string;
    overlayMesh: Mesh;
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

export interface DeviceScreenAnchor {
  visibility: 'behind' | 'offscreen' | 'visible';
  x: number;
  y: number;
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
    for (const link of visibleLinks) {
      let group = this.#linkGroups.get(link.id);
      if (!group) {
        group = this.#createLinkGroup(link);
        this.#linkGroups.set(link.id, group);
        this.#linkRoot.add(group);
      } else {
        group.userData.line.material.dispose?.();
        group.userData.line.material = this.#createBaseLinkMaterial(link);
      }
      group.userData.link = link;
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

    this.#renderer.domElement.addEventListener('pointermove', this.#handlePointerMove);
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

  #handlePointerMove = (event: PointerEvent): void => {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#hoverPointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

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

  #handlePointerClick = (event: MouseEvent): void => {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const hits = this.#collectScenePointerHits();
    if (hits.deviceId) {
      this.#onSelectDevice(hits.deviceId);
    }
  };

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

    this.#updateLinkGeometry();
    this.#controls.update();
    this.#renderer.render(this.#scene, this.#camera);
  };

  #updateLinkGeometry(): void {
    for (const group of this.#linkGroups.values()) {
      const link = group.userData.link;
      const local = this.#deviceGroups.get(link.local_device_id);
      const remote = this.#deviceGroups.get(link.remote_device_id);
      if (!local || !remote) {
        continue;
      }

      const start = local.position.clone();
      const end = remote.position.clone();
      const delta = end.clone().sub(start);
      const length = Math.max(delta.length(), 0.001);

      group.userData.line.geometry.setFromPoints([start, end]);
      group.userData.line.geometry.computeBoundingSphere();
      group.userData.line.computeLineDistances?.();

      const midpoint = start.clone().add(end).multiplyScalar(0.5);
      const direction = delta.lengthSq() > 0 ? delta.clone().normalize() : new Vector3(0, 1, 0);
      group.userData.overlayMesh.position.copy(midpoint);
      group.userData.overlayMesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction);
      group.userData.overlayMesh.scale.set(1, length, 1);

      group.userData.hitMesh.position.copy(midpoint);
      group.userData.hitMesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction);
      group.userData.hitMesh.scale.set(1, length, 1);
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
    const childrenByDeviceId = new Map(
      Array.from(visibleIds, (deviceId) => [deviceId, [] as string[]])
    );
    const roots: string[] = [];
    const rootSet = new Set<string>();

    for (const device of devices) {
      const parentId = state.model.primaryParentDeviceById.get(device.id);
      if (parentId && visibleIds.has(parentId)) {
        const children = childrenByDeviceId.get(parentId) ?? [];
        children.push(device.id);
        childrenByDeviceId.set(parentId, children);
      } else {
        roots.push(device.id);
      }
    }

    for (const [deviceId, childIds] of childrenByDeviceId) {
      childIds.sort((leftId, rightId) =>
        `${deviceById.get(leftId)?.label ?? ''}`.localeCompare(`${deviceById.get(rightId)?.label ?? ''}`)
      );
      childrenByDeviceId.set(deviceId, childIds);
    }
    roots.sort((leftId, rightId) =>
      `${deviceById.get(leftId)?.label ?? ''}`.localeCompare(`${deviceById.get(rightId)?.label ?? ''}`)
    );
    roots.forEach((deviceId) => rootSet.add(deviceId));

    const depthSpacing = 5.6;
    const childRingStart = 4.2;
    const childRingStep = 2.6;
    const rootRingStart = 10.0;
    const rootRingStep = 6.0;
    const slotSpacing = 2.8;
    const childClusterPadding = 0.8;
    const relaxIterations = 8;
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
          const radius = baseRadius + (childIds.length > 0 ? childClusterPadding : 0);
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

    const placeSubtree = (deviceId: string) => {
      const anchor = anchorByDeviceId.get(deviceId);
      if (!anchor) {
        return;
      }

      const childIds = childrenByDeviceId.get(deviceId) ?? [];
      if (childIds.length === 0) {
        return;
      }

      placeConcentricGroup(
        childIds,
        anchor,
        anchor.y - depthSpacing,
        deviceId,
        childRingStart,
        childRingStep
      );
      for (const childId of childIds) {
        placeSubtree(childId);
      }
    };

    if (roots.length === 1) {
      anchorByDeviceId.set(roots[0], new Vector3(0, 0, 0));
    } else if (roots.length > 1) {
      placeConcentricGroup(roots, new Vector3(0, 0, 0), 0, 'roots', rootRingStart, rootRingStep);
    }

    for (const rootId of roots) {
      placeSubtree(rootId);
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
        const anchorStrength = rootSet.has(deviceId) ? 0.2 : 0.16;
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
    const lineGeometry = new BufferGeometry();
    lineGeometry.setFromPoints([new Vector3(), new Vector3()]);
    const line = new Line(lineGeometry, this.#createBaseLinkMaterial(link));
    line.userData.role = 'link-line';
    line.renderOrder = 1;
    group.add(line);

    const overlayMesh = new Mesh(
      new CylinderGeometry(0.12, 0.12, 1, 16, 1, true),
      new MeshBasicMaterial({
        color: 0x0f62fe,
        depthWrite: false,
        opacity: 0,
        side: DoubleSide,
        transparent: true,
      })
    );
    overlayMesh.userData.role = 'link-overlay';
    overlayMesh.renderOrder = 2;
    group.add(overlayMesh);

    const hitMesh = new Mesh(
      new CylinderGeometry(0.35, 0.35, 1, 12, 1, true),
      new MeshBasicMaterial({
        color: 0xffffff,
        depthWrite: false,
        opacity: 0,
        side: DoubleSide,
        transparent: true,
      })
    );
    hitMesh.userData.role = 'link-hit';
    group.add(hitMesh);

    group.userData = {
      hitMesh,
      kind: 'link',
      line,
      link,
      linkId: link.id,
      overlayMesh,
    };

    return group;
  }

  #isGuestAccessLink(link: ViewLink): boolean {
    return (
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment?.vlan_tag !== null &&
      link.guest_attachment?.vlan_tag !== undefined
    );
  }

  #isGuestTrunkLink(link: ViewLink): boolean {
    return (
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment?.vlan_tag === null &&
      Array.isArray(link.guest_attachment?.trunk_vlans) &&
      link.guest_attachment.trunk_vlans.length > 0
    );
  }

  #baseLinkStyle(link: ViewLink): {
    color: number;
    dashed: boolean;
    opacity: number;
    renderOrder: number;
  } {
    if (this.#isGuestAccessLink(link)) {
      return {
        color: guestAttachmentNetworkColor(link.guest_attachment) ?? 0x64748b,
        dashed: false,
        opacity: 0.94,
        renderOrder: 2,
      };
    }
    if (this.#isGuestTrunkLink(link)) {
      return { color: 0x4b5563, dashed: false, opacity: 0.9, renderOrder: 1 };
    }
    if (link.protocol === 'proxmox_guest_link') {
      return { color: 0x64748b, dashed: false, opacity: 0.82, renderOrder: 1 };
    }
    if (link.protocol === 'proxmox_uplink') {
      return { color: 0x43556d, dashed: false, opacity: 0.76, renderOrder: 1 };
    }
    return { color: 0x4b5563, dashed: false, opacity: 0.76, renderOrder: 1 };
  }

  #createLineMaterial(style: {
    color: number;
    dashed: boolean;
    opacity: number;
  }): LineBasicMaterial | LineDashedMaterial {
    if (style.dashed) {
      return new LineDashedMaterial({
        color: style.color,
        dashSize: 0.55,
        depthWrite: false,
        gapSize: 0.325,
        opacity: style.opacity,
        transparent: true,
      });
    }

    return new LineBasicMaterial({
      color: style.color,
      depthWrite: false,
      opacity: style.opacity,
      transparent: true,
    });
  }

  #createBaseLinkMaterial(link: ViewLink): LineBasicMaterial | LineDashedMaterial {
    return this.#createLineMaterial(this.#baseLinkStyle(link));
  }

  #ensureLinkMaterial(
    group: LinkGroup,
    style: { color: number; dashed: boolean; opacity: number; renderOrder: number }
  ): void {
    const currentMaterial = group.userData.line.material;
    const shouldBeDashed = Boolean(style.dashed);
    const isDashed = currentMaterial.type === 'LineDashedMaterial';

    if (isDashed !== shouldBeDashed) {
      currentMaterial.dispose?.();
      group.userData.line.material = this.#createLineMaterial(style);
    }

    group.userData.line.material.color.setHex(style.color);
    group.userData.line.material.opacity = style.opacity;
    group.userData.line.material.depthWrite = false;
    group.userData.line.renderOrder = style.renderOrder;
  }

  #guestHighlightStyleForLink(
    link: ViewLink,
    pathState: ReturnType<typeof computeUpstreamPath>
  ): { color: number; dashed: boolean; opacity: number; renderOrder: number } | null {
    const highlight = pathState.guestHighlight;
    if (!highlight) {
      return null;
    }
    if (link.id === highlight.accessLinkId) {
      return {
        color: highlight.color ?? 0x0f62fe,
        dashed: false,
        opacity: 1,
        renderOrder: 2,
      };
    }
    if (highlight.trunkLinkId && link.id === highlight.trunkLinkId) {
      return {
        color: highlight.color ?? 0x0f62fe,
        dashed: true,
        opacity: 0.98,
        renderOrder: 1,
      };
    }
    return null;
  }

  #devicePairKeyForLink(link: ViewLink): string {
    return pairKey(link.local_device_id, link.remote_device_id);
  }

  #suppressedParallelGuestLinkIds(
    state: TopologyStoreState
  ): Set<string> {
    const highlightedLinkIds = new Set<string>();
    const highlightedPairKeys = new Set<string>();

    for (const pathState of [state.hoveredPath, state.selectedPath]) {
      const highlight = pathState.guestHighlight;
      if (!highlight) {
        continue;
      }

      for (const linkId of [highlight.accessLinkId, highlight.trunkLinkId]) {
        if (!linkId) {
          continue;
        }
        const link = state.snapshot.links.find((candidate) => candidate.id === linkId);
        if (!link || link.protocol !== 'proxmox_guest_link') {
          continue;
        }

        highlightedLinkIds.add(link.id);
        highlightedPairKeys.add(this.#devicePairKeyForLink(link));
      }
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
    const suppressedLinkIds = this.#suppressedParallelGuestLinkIds(state);

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
      this.#applyLinkStyle(group, state, suppressedLinkIds);
    }
  }

  #applyLinkStyle(group: LinkGroup, state: TopologyStoreState, suppressedLinkIds: Set<string>): void {
    const link = group.userData.link;
    const isHovered = link.id === state.hoveredLinkId;
    const guestHighlightStyle =
      this.#guestHighlightStyleForLink(link, state.hoveredPath) ??
      this.#guestHighlightStyleForLink(link, state.selectedPath);
    const baseStyle = guestHighlightStyle ?? this.#baseLinkStyle(link);
    const style = isHovered
      ? {
          ...baseStyle,
          color: 0xd97706,
          opacity: Math.max(baseStyle.opacity, 0.98),
        }
      : baseStyle;
    this.#ensureLinkMaterial(group, style);

    const isSuppressed = suppressedLinkIds.has(link.id);
    group.userData.line.visible = !isSuppressed;
    group.userData.hitMesh.visible = !isSuppressed;
    if (isSuppressed) {
      (group.userData.overlayMesh.material as MeshBasicMaterial).opacity = 0;
      group.userData.overlayMesh.visible = false;
      return;
    }

    const suppressPathOverlay = Boolean(guestHighlightStyle);
    const isOnHoveredPath = !isHovered && !suppressPathOverlay && state.hoveredPath.linkIds.has(link.id);
    const isOnSelectedPath =
      !isHovered &&
      !isOnHoveredPath &&
      !suppressPathOverlay &&
      state.selectedPath.linkIds.has(link.id);
    const overlayMaterial = group.userData.overlayMesh.material as MeshBasicMaterial;
    overlayMaterial.color.setHex(isHovered || isOnHoveredPath ? 0xd97706 : 0x0f62fe);
    overlayMaterial.opacity = isHovered ? 0.92 : isOnHoveredPath ? 0.72 : isOnSelectedPath ? 0.66 : 0;
    group.userData.overlayMesh.visible = overlayMaterial.opacity > 0;
  }
}
