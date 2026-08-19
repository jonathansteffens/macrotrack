/**
 * Types for the vendored qrcode-generator (Kazuhiko Arase, MIT — see
 * qrcode.js header). Vendored as a single file rather than an npm dependency
 * deliberately: package.json changes feed the expo-updates fingerprint, and a
 * pure-JS vendored file keeps QR sharing OTA-deliverable.
 */
declare function qrcode(
  /** 0 = pick the smallest version that fits. */
  typeNumber: number,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
): {
  addData(data: string, mode?: 'Byte' | 'Numeric' | 'Alphanumeric' | 'Kanji'): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};
export default qrcode;
