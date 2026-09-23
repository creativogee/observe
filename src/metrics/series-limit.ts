/**
 * Serialises a label object into the map key that identifies its series.
 *
 * Keys are sorted first: `JSON.stringify` preserves insertion order, so
 * `{ route, method }` and `{ method, route }` would otherwise be two different
 * series for what is the same label set.
 */
export function stringifyLabel(label: Record<string, string | number>): string {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(label).sort()) {
    sorted[key] = label[key];
  }
  return JSON.stringify(sorted);
}

export const MAX_SERIES_PER_METRIC = 1_000;

/**
 * Whether a metric may record under `key`.
 *
 * Refuses rather than throws. The first refusal is logged, once per metric.
 */
export function admitsSeries(
  metricName: string,
  values: Record<string, unknown>,
  key: string,
  state: { warned: boolean },
): boolean {
  if (key in values) {
    return true;
  }

  if (!state.warned) {
    if (Object.keys(values).length < MAX_SERIES_PER_METRIC) {
      return true;
    }
    state.warned = true;
    console.warn(
      `[observe] Metric "${metricName}" reached ${MAX_SERIES_PER_METRIC} distinct label combinations; ` +
        `further label values are being ignored. This usually means a label carries something unbounded ` +
        `(a user id, a request id, a URL). Existing series keep recording.`,
    );
  }
  return false;
}
