import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, useAnimatedValue, View } from 'react-native';

import { ThemedText } from './themed-text';

import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Progress state for the on-device estimate: a bar that eases toward (but
 * never reaches) done, plus a pulsing stage label that cycles through what
 * the model is conceptually doing. Purely cosmetic — llama.rn gives no real
 * progress signal until token streaming lands — but it reads as determinate
 * instead of a frozen spinner.
 */

const STAGES = ['Identifying foods…', 'Estimating portions…', 'Matching the database…'];
const STAGE_MS = 2600;

export function EstimatingIndicator() {
  const theme = useTheme();
  const [stage, setStage] = useState(0);
  const progress = useAnimatedValue(0);
  const pulse = useAnimatedValue(1);

  useEffect(() => {
    // Ease to 90% over roughly a typical estimate's duration, then hold.
    Animated.timing(progress, {
      toValue: 0.9,
      duration: 12000,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // drives a width — layout property
    }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    const t = setInterval(() => setStage((s) => (s + 1) % STAGES.length), STAGE_MS);
    return () => {
      loop.stop();
      clearInterval(t);
    };
  }, [progress, pulse]);

  return (
    <View style={styles.container}>
      <View style={[styles.track, { backgroundColor: theme.backgroundElement }]}>
        <Animated.View
          style={[
            styles.fill,
            {
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
      <Animated.View style={{ opacity: pulse }}>
        <ThemedText type="small" themeColor="textSecondary">
          {STAGES[stage]}
        </ThemedText>
      </Animated.View>
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
});
