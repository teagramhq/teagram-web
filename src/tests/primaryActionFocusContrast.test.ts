import {describe, expect, it} from 'vitest';
import {hexToRgb, relativeLuminance} from '@helpers/color';
import {colorMap} from '@helpers/themeController';

const themeNames = ['day', 'night', 'light', 'tinted'] as const;

function contrastRatio(first: string, second: string) {
  const firstLuminance = relativeLuminance(hexToRgb(first));
  const secondLuminance = relativeLuminance(hexToRgb(second));
  return (Math.max(firstLuminance, secondLuminance) + .05) /
    (Math.min(firstLuminance, secondLuminance) + .05);
}

describe('primary action focus ring contrast', () => {
  it('keeps the theme text color at 3:1 against each surface and background', () => {
    for(const themeName of themeNames) {
      const colors = colorMap[themeName]!;
      const ringColor = colors['primary-text-color']!;

      expect(contrastRatio(ringColor, colors['surface-color']!)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(ringColor, colors['background-color']!)).toBeGreaterThanOrEqual(3);
    }
  });
});
