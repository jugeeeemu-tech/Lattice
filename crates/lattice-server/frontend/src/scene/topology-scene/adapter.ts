import {
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
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

import type { ViewDevice } from '../../generated';
import type { TopologyStoreState } from '../../state/topology-store';
import {
  deploymentColor,
} from '../../topology/view-model';
import {
  deviceVisualSpec,
  layoutRadiusForDevice,
} from '../../topology/device-visuals';
import { projectionInsetFromDesktopInset } from '../scene-layout';
import { computeNetworkLayoutTargets } from './layout';
import {
  computeParallelLinkOffsets,
  createLinkGroup,
  linkHitMeshes,
  resolveLinkIntersection,
  updateLinkGeometry,
  updateLinkStyles,
} from './link-visuals';
import type { DeviceGroup, DeviceScreenAnchor, LinkGroup } from './types';

type SceneHoverTarget =
  | { deviceId: string; kind: 'device' }
  | { kind: 'link'; linkId: string }
  | null;

const ROTATION_DRAG_THRESHOLD_PX = 4;

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
    window.removeEventListener('click', this.#handleGlobalClickCapture, true);
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
    const visibleDevices = state.snapshot.devices.filter((device) => state.model.sceneDeviceIds.has(device.id));
    const visibleDeviceSet = new Set(visibleDevices.map((device) => device.id));
    const targetByDeviceId = computeNetworkLayoutTargets(visibleDevices, state);
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

    const visibleLinks = state.snapshot.links.filter((link) => state.model.visibleLinkIds.has(link.id));
    const parallelOffsets = computeParallelLinkOffsets(visibleLinks);
    for (const link of visibleLinks) {
      let group = this.#linkGroups.get(link.id);
      if (!group) {
        group = createLinkGroup(link);
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
    return { x: anchor.x, y: anchor.y };
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
    window.addEventListener('click', this.#handleGlobalClickCapture, true);
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

    this.#renderer.domElement.setPointerCapture?.(event.pointerId);
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

    if (this.#renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.#renderer.domElement.releasePointerCapture?.(event.pointerId);
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

    if (this.#renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.#renderer.domElement.releasePointerCapture?.(event.pointerId);
    }

    this.#primaryPointerId = null;
    this.#pointerDownPosition = null;
    this.#sceneDragInProgress = false;
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

  #handleGlobalClickCapture = (event: MouseEvent): void => {
    if (!this.#suppressNextClick && !this.#sceneDragInProgress) {
      return;
    }

    this.#suppressNextClick = false;
    this.#sceneDragInProgress = false;
    event.preventDefault();
    event.stopPropagation();
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
      ...linkHitMeshes(this.#linkGroups.values()),
    ];
  }

  #resolveSceneIntersection(
    object: Object3D
  ): { deviceId: string; kind: 'device' } | { kind: 'link'; linkId: string } | null {
    if (object.userData.role === 'device-mesh') {
      const group = this.#findAncestorByKind(object, 'device') as DeviceGroup | null;
      return group?.userData?.deviceId ? { deviceId: group.userData.deviceId, kind: 'device' } : null;
    }

    return resolveLinkIntersection(object);
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
    const cameraPosition = new Vector3().setFromMatrixPosition(this.#camera.matrixWorld);
    updateLinkGeometry(this.#linkGroups.values(), this.#deviceGroups, cameraPosition, performance.now() * 0.001);
    this.#renderer.render(this.#scene, this.#camera);
  };

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

  #createDeviceGeometry(device: ViewDevice) {
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

  #updateObjectStyles(state: TopologyStoreState): void {
    for (const [deviceId, group] of this.#deviceGroups) {
      const isSelected = deviceId === state.selectedDeviceId;
      const isHovered = deviceId === state.hoveredDeviceId;
      const onSelectedPath = state.selectedPath.deviceIds.has(deviceId) && !isSelected;
      const onHoveredPath = state.hoveredPath.deviceIds.has(deviceId) && !isSelected && !isHovered;

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

    updateLinkStyles(this.#linkGroups.values(), state);
  }
}
