import {existsSync, writeFileSync} from 'node:fs';

type PerformanceReport = {
  diagnostics: Record<string, unknown>,
  variants: Record<string, Record<string, Record<string, unknown[]>>>
};

export function writePerformanceReport(path: string, report: PerformanceReport) {
  const hasMeasurements = Object.values(report.variants).some((scales) =>
    Object.values(scales).some((scenarios) => Object.values(scenarios).some((samples) => samples.length > 0))
  );
  if(!hasMeasurements && !Object.keys(report.diagnostics).length && existsSync(path)) return;
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}
