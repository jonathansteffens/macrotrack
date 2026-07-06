import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';

type Props = {
  values: number[];
  /** X-axis labels, same length as values; ~4 are shown evenly spaced. */
  labels: string[];
  color: string;
  goal?: number;
  /** Optional smoothed series drawn as a line over the bars (0 = no point). */
  overlay?: number[];
  height?: number;
};

/** Minimal dependency-free daily bar chart with an optional goal line. */
export function BarChart({ values, labels, color, goal, overlay, height = 180 }: Props) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const topPad = 16;
  const bottomPad = 18;
  const chartH = height - topPad - bottomPad;
  const max = Math.max(...values, goal ?? 0, 1) * 1.08;
  const n = values.length;
  const gap = n > 45 ? 1 : 2;
  const barW = width > 0 ? Math.max((width - gap * (n - 1)) / n, 1) : 0;

  const labelEvery = Math.max(1, Math.ceil(n / 4));
  const goalY = goal != null ? topPad + chartH * (1 - Math.min(goal / max, 1)) : null;

  const overlayPoints = (overlay ?? [])
    .map((v, i) =>
      v > 0
        ? `${i * (barW + gap) + barW / 2},${topPad + chartH * (1 - Math.min(v / max, 1))}`
        : null
    )
    .filter((p): p is string => p !== null)
    .join(' ');

  return (
    <View style={styles.container} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
          {values.map((v, i) => {
            const h = Math.max(chartH * (v / max), v > 0 ? 2 : 0);
            return (
              <Rect
                key={i}
                x={i * (barW + gap)}
                y={topPad + chartH - h}
                width={barW}
                height={h}
                rx={Math.min(2, barW / 3)}
                fill={color}
                opacity={goal != null && v > goal ? 1 : 0.65}
              />
            );
          })}
          {overlayPoints.length > 0 && (
            <Polyline
              points={overlayPoints}
              fill="none"
              stroke={theme.text}
              strokeWidth={1.5}
              opacity={0.7}
            />
          )}
          {goalY != null && (
            <Line
              x1={0}
              y1={goalY}
              x2={width}
              y2={goalY}
              stroke={theme.textSecondary}
              strokeWidth={1}
              strokeDasharray="5,4"
            />
          )}
          {labels.map((label, i) =>
            i % labelEvery === 0 ? (
              <SvgText
                key={i}
                x={i * (barW + gap) + barW / 2}
                y={height - 4}
                fontSize={10}
                fill={theme.textSecondary}
                textAnchor={i === 0 ? 'start' : 'middle'}>
                {label}
              </SvgText>
            ) : null
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
