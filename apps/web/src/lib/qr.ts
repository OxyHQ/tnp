/// <reference path="../qrcode.d.ts" />
/**
 * QR codes for WireGuard configs, drawn as one SVG path.
 *
 * The official WireGuard apps import a tunnel by scanning its config as a QR
 * code. The config holds the device's private key, so the code is computed
 * here, in the page, and never leaves it: no image service, no `data:` URL
 * handed to anything, no canvas export.
 */

import { create } from 'qrcode/lib/core/qrcode.js';

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  isDark(row: number, col: number): boolean;
}

export function qrMatrix(text: string): QrMatrix {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  return { size: modules.size, isDark: (row, col) => Boolean(modules.get(row, col)) };
}

/** Quiet zone the spec requires around the symbol, in modules. */
export const QR_MARGIN = 4;

/**
 * The dark modules as an SVG path in a `(size + 2·margin)²` viewBox: one
 * `h` run per horizontal stretch of dark modules, so a config-sized code is a
 * few kilobytes of path data rather than thousands of elements.
 */
export function qrPath(matrix: QrMatrix, margin = QR_MARGIN): string {
  let d = '';
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  return d;
}
