/** Group items by a key extractor into a Map of arrays */
export const groupBy = <T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> =>
  items.reduce((acc, item) => {
    const key = keyFn(item);
    const arr = acc.get(key) ?? [];
    arr.push(item);
    return acc.set(key, arr);
  }, new Map<K, T[]>());

/** Convert an array to a Map using a key extractor, with optional value transform */
export function toMap<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T>;
export function toMap<T, K, V>(items: T[], keyFn: (t: T) => K, valueFn: (t: T) => V): Map<K, V>;
export function toMap<T, K, V>(items: T[], keyFn: (t: T) => K, valueFn?: (t: T) => V): Map<K, T | V> {
  return new Map(items.map((item) => [keyFn(item), valueFn ? valueFn(item) : item] as [K, T | V]));
}

/** Reduce items by a string key with an init value and accumulator */
export const reduceBy = <T, V>(items: T[], keyFn: (t: T) => string, init: () => V, accumulate: (acc: V, t: T) => V): Record<string, V> =>
  items.reduce(
    (result, t) => {
      const k = keyFn(t);
      return { ...result, [k]: accumulate(result[k] ?? init(), t) };
    },
    {} as Record<string, V>,
  );
