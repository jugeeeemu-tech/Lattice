import { describe, expect, it } from 'vitest';

import {
  DESKTOP_FREE_AREA_CENTER_WEIGHT,
  projectionInsetFromDesktopInset,
} from '../../src/scene/scene-layout';

describe('scene-layout', () => {
  it('uses a 6:4 weighting when translating sidebar inset into projection inset', () => {
    expect(DESKTOP_FREE_AREA_CENTER_WEIGHT).toBe(0.6);
    expect(projectionInsetFromDesktopInset(0)).toBe(0);
    expect(projectionInsetFromDesktopInset(120)).toBe(72);
    expect(projectionInsetFromDesktopInset(300)).toBe(180);
  });

  it('never returns a negative projection inset', () => {
    expect(projectionInsetFromDesktopInset(-120)).toBe(0);
  });
});
