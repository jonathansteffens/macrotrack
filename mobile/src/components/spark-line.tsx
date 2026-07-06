import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

/**
 * Small line chart scaled to the data's own min/max (unlike BarChart's
 * zero-based scale) — right for slow-moving series like body weight.
 * Zero values are treated as gaps.
 */
export function SparkLine({
  values,
  color,
  height = 64,
}: {
  values: number[];
  color: string;
  height?: number;
}) {
  const [width, setWidth] = useState(0);

  const present = values.filter((v) => v > 0);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const pad = 6;

  const points = values
    .map((v, i) =>
      v > 0
        ? {
            x: pad + (i / Math.max(values.length - 1, 1)) * (width - pad * 2),
            y: pad + (1 - (v - min) / span) * (height - pad * 2),
          }
        : null
    )
    .filter((p): p is { x: number; y: number } => p !== null);

  return (
    <View style={styles.container} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && present.length > 0 && (
        <Svg width={width} height={height}>
          {points.length > 1 && (
            <Polyline
              points={points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={2}
            />
          )}
          {points.length > 0 && (
            <Circle
              cx={points[points.length - 1].x}
              cy={points[points.length - 1].y}
              r={3}
              fill={color}
            />
          )}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
});
