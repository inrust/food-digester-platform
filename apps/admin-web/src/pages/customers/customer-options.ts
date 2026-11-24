export function customerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function customerOptionLabels<T>(
  customers: readonly T[],
  id: (customer: T) => string,
  name: (customer: T) => string,
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const customer of customers) {
    const key = customerNameKey(name(customer));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    customers.map((customer) => {
      const label = name(customer);
      const customerId = id(customer);
      return [customerId, (counts.get(customerNameKey(label)) ?? 0) > 1 ? `${label} (${customerId})` : label];
    }),
  );
}
