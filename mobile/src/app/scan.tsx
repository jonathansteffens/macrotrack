import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MacroColors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { todayKey } from '@/lib/dates';
import { getCustomFoodByBarcode } from '@/lib/foods';
import { lookupBarcode } from '@/lib/off';

export default function ScanScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ day?: string; meal?: string }>();
  const day = params.day ?? todayKey();
  // May be undefined (quick actions) — the food screen guesses one then.
  const meal = params.meal;

  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState<'scanning' | 'looking_up'>('scanning');
  const [manualCode, setManualCode] = useState('');
  const busy = useRef(false);

  const handleCode = async (code: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus('looking_up');

    // The user's own foods win over Open Food Facts (covers OFF misses and
    // products the user has corrected by re-entering).
    const custom = await getCustomFoodByBarcode(code);
    if (custom) {
      router.replace({ pathname: '/food', params: { ref: custom.ref, day, meal } });
      return;
    }

    const result = await lookupBarcode(code);
    if (result.status === 'found') {
      router.replace({ pathname: '/food', params: { ref: result.food.ref, day, meal } });
      return;
    }

    const resume = () => {
      busy.current = false;
      setStatus('scanning');
    };
    if (result.status === 'not_found') {
      Alert.alert(
        'Product not found',
        `Barcode ${code} isn’t in Open Food Facts. Add it as a custom food from its nutrition label?`,
        [
          { text: 'Keep scanning', style: 'cancel', onPress: resume },
          {
            text: 'Add custom food',
            onPress: () =>
              router.replace({ pathname: '/custom-food', params: { barcode: code, day, meal } }),
          },
        ]
      );
    } else {
      Alert.alert('Lookup failed', result.message, [{ text: 'OK', onPress: resume }]);
    }
  };

  if (!permission?.granted) {
    return (
      <ThemedView style={styles.permissionRoot}>
        <SafeAreaView style={styles.permissionContent}>
          <ThemedText type="default" style={styles.permissionText}>
            MacroTrack needs camera access to scan barcodes.
          </ThemedText>
          {permission?.canAskAgain !== false ? (
            <Pressable
              style={[styles.primaryButton, { backgroundColor: MacroColors.kcal }]}
              onPress={requestPermission}>
              <ThemedText type="smallBold" style={styles.primaryButtonText}>
                Allow camera
              </ThemedText>
            </Pressable>
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.permissionText}>
              Camera access was denied — enable it in system settings, or type the barcode below.
            </ThemedText>
          )}
          <ManualEntry
            value={manualCode}
            onChange={setManualCode}
            onSubmit={() => manualCode.trim() && handleCode(manualCode.trim())}
          />
          <Pressable onPress={() => router.back()} style={styles.cancelLink}>
            <ThemedText type="small" themeColor="textSecondary">
              Cancel
            </ThemedText>
          </Pressable>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <View style={styles.cameraRoot}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
        }}
        onBarcodeScanned={({ data }) => {
          if (data) handleCode(data);
        }}
      />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.topBar}>
          <ThemedText type="smallBold" style={styles.overlayText}>
            {status === 'looking_up' ? 'Looking up product…' : 'Point at a food barcode'}
          </ThemedText>
          <Pressable
            style={styles.closeButton}
            hitSlop={12}
            onPress={() => router.back()}>
            <ThemedText type="smallBold" style={styles.overlayText}>
              ✕
            </ThemedText>
          </Pressable>
        </View>
        <View style={styles.reticle} pointerEvents="none" />
        <View style={[styles.bottomBar, { backgroundColor: theme.background }]}>
          <ManualEntry
            value={manualCode}
            onChange={setManualCode}
            onSubmit={() => manualCode.trim() && handleCode(manualCode.trim())}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

function ManualEntry({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.manualRow}>
      <TextInput
        style={[
          styles.manualInput,
          { backgroundColor: theme.backgroundElement, color: theme.text },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder="Or type barcode digits…"
        placeholderTextColor={theme.textSecondary}
        keyboardType="number-pad"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
      />
      <Pressable
        style={[styles.primaryButton, { backgroundColor: MacroColors.kcal }]}
        onPress={onSubmit}>
        <ThemedText type="smallBold" style={styles.primaryButtonText}>
          Go
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  cameraRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
  },
  overlayText: {
    color: '#ffffff',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 4,
  },
  closeButton: {
    position: 'absolute',
    right: Spacing.four,
    top: Spacing.three,
  },
  reticle: {
    alignSelf: 'center',
    width: '70%',
    height: 140,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.7)',
    borderRadius: Spacing.three,
  },
  bottomBar: {
    padding: Spacing.three,
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
  },
  manualRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
  },
  manualInput: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: 16,
  },
  primaryButton: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + 2,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
  },
  permissionRoot: {
    flex: 1,
  },
  permissionContent: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  permissionText: {
    textAlign: 'center',
  },
  cancelLink: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
});
