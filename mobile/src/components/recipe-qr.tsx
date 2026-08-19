import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import qrcode from '@/lib/vendor/qrcode';

/**
 * A QR code as a single SVG path (one element regardless of module count —
 * thousands of <Rect>s would chug). Always dark-on-white inside its own white
 * card, theme-independent: scanners want contrast, not aesthetics.
 */
export function QrCode({ data, size = 260 }: { data: string; size?: number }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(data, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { path: d, count: n };
  }, [data]);

  // 4-module quiet zone on every side, per the QR spec.
  const total = count + 8;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`-4 -4 ${total} ${total}`}>
        <Rect x={-4} y={-4} width={total} height={total} fill="#ffffff" />
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}
