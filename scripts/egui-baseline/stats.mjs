export function aggregateValues(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("aggregate values must be a non-empty finite-number array");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    min: sorted[0],
    max: sorted.at(-1),
    median,
    p95: sorted[p95Index],
    samples: [...values],
  };
}
