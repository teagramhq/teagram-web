import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {writePerformanceReport} from '../../e2e/performanceReport';

test('preserves collected measurements when a later worker has no results', () => {
  const directory = mkdtempSync(join(tmpdir(), 'performance-report-'));
  const path = join(directory, 'report.json');
  try {
    writeFileSync(path, JSON.stringify({variants: {head: {'100x': {scrollBack2k: [{ms: 120}]}}}}));
    writePerformanceReport(path, {diagnostics: {}, variants: {head: {'100x': {}}, base: {'100x': {}}}});
    expect(JSON.parse(readFileSync(path, 'utf8')).variants.head['100x'].scrollBack2k).toEqual([{ms: 120}]);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('writes newly collected measurements for the performance summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'performance-report-'));
  const path = join(directory, 'report.json');
  try {
    const report = {diagnostics: {}, variants: {head: {'100x': {scrollBack2k: [{ms: 90}]}}, base: {'100x': {}}}};
    writePerformanceReport(path, report);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('writes diagnostic-only evidence even when no scenario completed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'performance-report-'));
  const path = join(directory, 'report.json');
  try {
    writeFileSync(path, '{}');
    const report = {diagnostics: {'100x': {recorderComparison: {pairs: [1]}}}, variants: {head: {'100x': {}}, base: {'100x': {}}}};
    writePerformanceReport(path, report);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
