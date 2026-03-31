export const DESKTOP_FREE_AREA_CENTER_WEIGHT = 0.6;

export function projectionInsetFromDesktopInset(leftInset: number): number {
  return Math.max(0, leftInset) * DESKTOP_FREE_AREA_CENTER_WEIGHT;
}
