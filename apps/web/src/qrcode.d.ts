/**
 * The one entry point of `qrcode` (1.5.4, pinned exactly in package.json) the
 * dashboard uses: the encoder core, without its canvas/PNG/terminal renderers.
 * The page draws the modules itself as an SVG path, so no image or script
 * source beyond 'self' is needed under the CSP.
 */
declare module 'qrcode/lib/core/qrcode.js' {
  export interface QrBitMatrix {
    size: number;
    get(row: number, col: number): number | boolean;
  }
  export interface QrSymbol {
    modules: QrBitMatrix;
    version: number;
  }
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): QrSymbol;
}
