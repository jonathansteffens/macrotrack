import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';

type Props = {
  values: number[];
  /** X-axis labels, same length as values; ~4 are shown evenly spaced. */
  labels: string[];
  color: string;
  goal?: number;
  /** Optional smoothed series drawn as a dotted muted line (0 = no point). */
  overlay?: number[];
  height?: number;
};

/**
 * Minimal dependency-free daily line chart with an optional goal line.
 * Days with nothing logged (value 0) BREAK the line — plotting them would
 * draw a false dip to zero; a gap is the honest shape of missing data.
 */
export function LineChart({ values, labels, color, goal, overlay, height = 180 }: Props) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const topPad = 16;
  const bottomPad = 18;
  const chartH = height - topPad - bottomPad;
  const max = Math.max(...values, goal ?? 0, 1) * 1.08;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i * width) / (n - 1) : width / 2);
  const y = (v: number) => topPad + chartH * (1 - Math.min(v / max, 1));

  // Contiguous logged runs; a zero (nothing logged) ends the current run.
  const segments: { i: number; v: number }[][] = [];
  {
    let run: { i: number; v: number }[] = [];
    values.forEach((v, i) => {
      if (v > 0) run.push({ i, v });
      else if (run.length > 0) {
        segments.push(run);
        run = [];
      }
    });
    if (run.length > 0) segments.push(run);
  }
  const points = segments.flat();
  const lastPoint = points.length > 0 ? points[points.length - 1] : null;
  // Per-point dots only when they won't turn into noise (a month or less).
  const showDots = n <= 31;

  const labelEvery = Math.max(1, Math.ceil(n / 4));
  const goalY = goal != null ? y(Math.min(goal, max)) : null;

  const overlayPoints = (overlay ?? [])
    .map((v, i) => (v > 0 ? `${x(i)},${y(v)}` : null))
    .filter((p): p is string => p !== null)
    .join(' ');

  return (
    <View style={styles.container} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
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
          {overlayPoints.length > 0 && (
            <Polyline
              points={overlayPoints}
              fill="none"
              stroke={theme.text}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeDasharray="1,5"
              opacity={0.6}
            />
          )}
          {segments.map((seg, s) =>
            seg.length > 1 ? (
              <Polyline
                key={s}
                points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : (
              // A lone logged day between gaps has no line to ride — it gets a
              // dot regardless of range so the data never silently vanishes.
              <Circle key={s} cx={x(seg[0].i)} cy={y(seg[0].v)} r={2.5} fill={color} />
            )
          )}
          {showDots &&
            points.map((p) => (
              <Circle key={`d${p.i}`} cx={x(p.i)} cy={y(p.v)} r={2.5} fill={color} />
            ))}
          {lastPoint && (
            <Circle cx={x(lastPoint.i)} cy={y(lastPoint.v)} r={3.5} fill={color} />
          )}
          {labels.map((label, i) =>
            i % labelEvery === 0 ? (
              <SvgText
                key={i}
                x={x(i)}
                y={height - 4}
                fontSize={10}
                fill={theme.textSecondary}
                textAnchor={i === 0 ? 'start' : i >= n - labelEvery ? 'end' : 'middle'}>
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
