import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, useAnimatedValue, View } from 'react-native';

import { ThemedText } from './themed-text';

import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Progress for the on-device estimate, driven by real activity (not a timer):
 * an indeterminate shimmer until the first item streams in, then a bar that
 * advances a genuine fraction per streamed item — items / (items + 1.5), which
 * approaches but never reaches full. Cosmetic-honest: no fabricated percentage
 * is ever shown, and the bar only moves when the model actually produces an
 * item. `count` is how many items have decoded so far.
 */

const STAGES = ['Identifying foods…', 'Estimating portions…', 'Matching the database…'];
const STAGE_MS = 2600;

export function EstimatingIndicator({ count = 0 }: { count?: number }) {
  const theme = useTheme();
  const [stage, setStage] = useState(0);
  const progress = useAnimatedValue(0);
  const shimmer = useAnimatedValue(0);
  const started = count > 0;

  // Determinate advance once items begin streaming — each item nudges the bar
  // toward (but never to) full.
  useEffect(() => {
    if (!started) return;
    Animated.timing(progress, {
      toValue: Math.min(1, count / (count + 1.5)),
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // drives a width — layout property
    }).start();
  }, [count, started, progress]);

  // Indeterminate shimmer while nothing has streamed yet.
  useEffect(() => {
    if (started) return;
    shimmer.setValue(0);
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [started, shimmer]);

  // Cycle the "what it's doing" label only before items arrive; afterwards the
  // honest signal is the running item count.
  useEffect(() => {
    if (started) return;
    const t = setInterval(() => setStage((s) => (s + 1) % STAGES.length), STAGE_MS);
    return () => clearInterval(t);
  }, [started]);

  const label = started ? `Found ${count} item${count === 1 ? '' : 's'} so far…` : STAGES[stage];

  return (
    <View style={styles.container}>
      <View style={[styles.track, { backgroundColor: theme.backgroundElement }]}>
        {started ? (
          <Animated.View
            style={[
              styles.fill,
              { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
            ]}
          />
        ) : (
          <Animated.View
            style={[
              styles.shimmer,
              {
                left: shimmer.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['-35%', '100%'],
                }),
              },
            ]}
          />
        )}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.six,
  },
  track: {
    width: '80%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: MacroColors.kcal,
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '35%',
    borderRadius: 3,
    backgroundColor: MacroColors.kcal,
  },
});
