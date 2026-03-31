import type { DeviceScreenAnchor } from '../scene/topology-scene';

export interface HoverCardBounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface HoverCardSize {
  height: number;
  width: number;
}

export const HOVER_CARD_ESTIMATED_SIZE: HoverCardSize = {
  width: 320,
  height: 132,
};

const HOVER_CARD_MARGIN = 16;
const HOVER_CARD_OFFSET = 18;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveTreeHoverCardPosition(
  anchor: DeviceScreenAnchor,
  bounds: HoverCardBounds,
  size: HoverCardSize = HOVER_CARD_ESTIMATED_SIZE
): { x: number; y: number } {
  const minX = bounds.left + HOVER_CARD_MARGIN;
  const minY = bounds.top + HOVER_CARD_MARGIN;
  const maxX = Math.max(minX, bounds.right - size.width - HOVER_CARD_MARGIN);
  const maxY = Math.max(minY, bounds.bottom - size.height - HOVER_CARD_MARGIN);

  if (anchor.visibility === 'visible') {
    return {
      x: clamp(anchor.x + HOVER_CARD_OFFSET, minX, maxX),
      y: clamp(anchor.y + HOVER_CARD_OFFSET, minY, maxY),
    };
  }

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const deltaX = anchor.x - centerX;
  const deltaY = anchor.y - centerY;

  if (anchor.x <= bounds.left) {
    return {
      x: minX,
      y: clamp(anchor.y - size.height / 2, minY, maxY),
    };
  }
  if (anchor.x >= bounds.right) {
    return {
      x: maxX,
      y: clamp(anchor.y - size.height / 2, minY, maxY),
    };
  }
  if (anchor.y <= bounds.top) {
    return {
      x: clamp(anchor.x - size.width / 2, minX, maxX),
      y: minY,
    };
  }
  if (anchor.y >= bounds.bottom) {
    return {
      x: clamp(anchor.x - size.width / 2, minX, maxX),
      y: maxY,
    };
  }

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return {
      x: deltaX >= 0 ? maxX : minX,
      y: clamp(anchor.y - size.height / 2, minY, maxY),
    };
  }

  return {
    x: clamp(anchor.x - size.width / 2, minX, maxX),
    y: deltaY >= 0 ? maxY : minY,
  };
}
