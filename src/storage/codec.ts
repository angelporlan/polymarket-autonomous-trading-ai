export function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue: unknown) =>
    typeof currentValue === "bigint"
      ? { __codexPolymarketBigInt: currentValue.toString() }
      : currentValue
  );
}

export function parseWithBigInts<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue: unknown) => {
    if (
      currentValue !== null &&
      typeof currentValue === "object" &&
      "__codexPolymarketBigInt" in currentValue
    ) {
      const encoded = (currentValue as { __codexPolymarketBigInt: unknown })
        .__codexPolymarketBigInt;
      if (typeof encoded !== "string" || !/^-?\d+$/.test(encoded)) {
        throw new Error("Invalid bigint encoding in persisted data.");
      }
      return BigInt(encoded);
    }
    return currentValue;
  }) as T;
}
