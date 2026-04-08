import type { ViewDevice } from '../../generated';

export function clampMagnitude(value: number, limit: number): number {
  return Math.max(-limit, Math.min(value, limit));
}

export function pairKey(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

export function hash01(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

export function compareDeviceIdsByLabel(
  leftId: string,
  rightId: string,
  deviceById: Map<string, ViewDevice>
): number {
  return `${deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
    `${deviceById.get(rightId)?.label ?? rightId}`
  );
}
