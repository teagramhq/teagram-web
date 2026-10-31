export type BundleResource = Pick<PerformanceResourceTiming, 'name' | 'startTime' | 'decodedBodySize'>;

export function sumBundleBytes(resources: BundleResource[], origin: string, startedAtMs: number, endedAtMs: number) {
  return resources.filter((entry) => {
    return entry.startTime >= startedAtMs && entry.startTime <= endedAtMs && new URL(entry.name).origin === origin && /\.(js|css)(?:[?#]|$)/i.test(entry.name);
  }).reduce((total, entry) => total + entry.decodedBodySize, 0);
}
