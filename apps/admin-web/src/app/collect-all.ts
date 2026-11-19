export async function collectAll<T>(
  load: (cursor: string | null) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
): Promise<readonly T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await load(cursor);
    items.push(...page.items);
    if (page.nextCursor === null || seen.has(page.nextCursor)) return items;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
