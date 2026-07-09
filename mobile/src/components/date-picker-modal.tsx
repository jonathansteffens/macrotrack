import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { dayKey, keyToDate, todayKey } from '@/lib/dates';
import { daysWithEntries } from '@/lib/log';

/**
 * Lightweight month-grid date picker — no new dependencies. Pages by month,
 * marks days that have any log entries (one cheap query per visible month), and
 * jumps to a tapped day. Built for the Today header's date label.
 */

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function DatePickerModal({
  selected,
  onSelect,
  onClose,
}: {
  selected: string;
  onSelect: (day: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [view, setView] = useState(() => {
    const d = keyToDate(selected);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [marked, setMarked] = useState<Set<string>>(new Set());

  useEffect(() => {
    const from = dayKey(new Date(view.y, view.m, 1));
    const to = dayKey(new Date(view.y, view.m + 1, 0));
    let live = true;
    daysWithEntries(from, to).then((s) => {
      if (live) setMarked(s);
    });
    return () => {
      live = false;
    };
  }, [view]);

  const today = todayKey();
  const firstWeekday = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  // Leading blanks to align day 1 under its weekday, then the month's days.
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const stepMonth = (dir: 1 | -1) =>
    setView((v) => {
      const d = new Date(v.y, v.m + dir, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Swallow taps inside the card so they don't dismiss. */}
        <Pressable onPress={() => {}}>
          <ThemedView type="background" style={styles.card}>
            <View style={styles.header}>
              <Pressable hitSlop={12} style={styles.nav} onPress={() => stepMonth(-1)}>
                <ThemedText type="subtitle" themeColor="textSecondary">
                  ‹
                </ThemedText>
              </Pressable>
              <ThemedText type="smallBold">
                {MONTHS[view.m]} {view.y}
              </ThemedText>
              <Pressable hitSlop={12} style={styles.nav} onPress={() => stepMonth(1)}>
                <ThemedText type="subtitle" themeColor="textSecondary">
                  ›
                </ThemedText>
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAYS.map((w, i) => (
                <ThemedText key={i} type="small" themeColor="textSecondary" style={styles.weekday}>
                  {w}
                </ThemedText>
              ))}
            </View>

            <View style={styles.grid}>
              {cells.map((d, i) => {
                if (d == null) return <View key={i} style={styles.cell} />;
                const key = dayKey(new Date(view.y, view.m, d));
                const isSelected = key === selected;
                const isToday = key === today;
                const hasEntries = marked.has(key);
                return (
                  <Pressable
                    key={i}
                    style={styles.cell}
                    onPress={() => onSelect(key)}>
                    <View
                      style={[
                        styles.dayInner,
                        isSelected && { backgroundColor: theme.tintSolid },
                      ]}>
                      <ThemedText
                        type="small"
                        style={isSelected ? styles.selectedText : undefined}
                        themeColor={isToday && !isSelected ? 'text' : undefined}>
                        {d}
                      </ThemedText>
                      {hasEntries && (
                        <View
                          style={[
                            styles.dot,
                            { backgroundColor: isSelected ? theme.tintText : theme.tint },
                          ]}
                        />
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.footer}>
              <Pressable hitSlop={8} onPress={() => onSelect(today)}>
                <ThemedText type="smallBold" themeColor="tint">
                  Today
                </ThemedText>
              </Pressable>
              <Pressable hitSlop={8} onPress={onClose}>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  Close
                </ThemedText>
              </Pressable>
            </View>
          </ThemedView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const CELL = 40;

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.four,
  },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.three,
    gap: Spacing.two,
    width: CELL * 7 + Spacing.three * 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.one,
  },
  nav: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekRow: {
    flexDirection: 'row',
  },
  weekday: {
    width: CELL,
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    width: CELL,
    height: CELL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayInner: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  dot: {
    position: 'absolute',
    bottom: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
});
