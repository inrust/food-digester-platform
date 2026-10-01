export const VIEWPORTS: number[];
export const GROUPS: Record<string, string[]>;
export const ABSENCE: Record<string, string>;
export function validateBindings(
  matrix: any,
  groups?: Record<string, string[]>,
  absence?: Record<string, string>,
): { menus: number; pages: number; positive: number; negative: number; groups: number };
