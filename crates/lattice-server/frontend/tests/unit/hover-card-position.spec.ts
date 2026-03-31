import { describe, expect, it } from 'vitest';

import { resolveTreeHoverCardPosition } from '../../src/components/hover-card-position';
import type { DeviceScreenAnchor } from '../../src/scene/topology-scene';

const bounds = {
  left: 320,
  top: 0,
  right: 1200,
  bottom: 720,
};

describe('resolveTreeHoverCardPosition', () => {
  it('places visible anchors near the device while staying inside the scene bounds', () => {
    const position = resolveTreeHoverCardPosition(
      { x: 680, y: 240, visibility: 'visible' },
      bounds
    );

    expect(position).toEqual({
      x: 698,
      y: 258,
    });
  });

  it('clamps offscreen anchors to the nearest visible edge', () => {
    expect(
      resolveTreeHoverCardPosition({ x: 0, y: 200, visibility: 'offscreen' }, bounds)
    ).toEqual({
      x: 336,
      y: 134,
    });

    expect(
      resolveTreeHoverCardPosition({ x: 1500, y: 180, visibility: 'offscreen' }, bounds)
    ).toEqual({
      x: 864,
      y: 114,
    });

    expect(
      resolveTreeHoverCardPosition({ x: 760, y: -120, visibility: 'offscreen' }, bounds)
    ).toEqual({
      x: 600,
      y: 16,
    });
  });

  it('treats behind-camera anchors like offscreen anchors and pins them to an edge', () => {
    const position = resolveTreeHoverCardPosition(
      { x: 900, y: 360, visibility: 'behind' } as DeviceScreenAnchor,
      bounds
    );

    expect(position).toEqual({
      x: 864,
      y: 294,
    });
  });
});
