import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
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
  // useCameraPermissions() does NOT request on mount (SDK 57 docs) — it only
  // reports. Without this the scanner opened straight onto "needs camera
  // access" and the OS dialog never appeared unless the user found the button,
  // which reads as the app being broken rather than as a permission prompt.
  //
  // Ask automatically the FIRST time only, i.e. while the status is still
  // undetermined. Once the user has actually said no, re-prompting on every
  // visit would be nagging; that case falls through to the explainer below,
  // where asking again is an explicit choice.
  const askedOnce = useRef(false);
  useEffect(() => {
    if (!permission || askedOnce.current) return;
    if (permission.status === 'undetermined') {
      askedOnce.current = true;
      requestPermission();
    }
  }, [permission, requestPermission]);
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
      // OFF sometimes has a name + partial macros but no usable energy — carry
      // whatever it returned into the custom-food form so it's half-filled.
      const partial = result.partial;
      const numStr = (v: number | null | undefined) => (v != null ? String(v) : undefined);
      Alert.alert(
        'Product not found',
        `Barcode ${code} isn’t in Open Food Facts. Add it as a custom food from its label, or search the database.`,
        [
          { text: 'Keep scanning', style: 'cancel', onPress: resume },
          {
            text: 'Search database instead',
            onPress: () => router.replace({ pathname: '/add', params: { day, meal } }),
          },
          {
            text: 'Add custom food',
            onPress: () =>
              router.replace({
                pathname: '/custom-food',
                params: {
                  barcode: code,
                  day,
                  meal,
                  prefillName: partial?.name,
                  prefillProtein: numStr(partial?.protein),
                  prefillCarbs: numStr(partial?.carbs),
                  prefillFat: numStr(partial?.fat),
                },
              }),
          },
        ]
      );
    } else {
      // status === 'error' — almost always no connectivity. New scans hit the
      // network; foods scanned before still resolve from the local cache.
      Alert.alert(
        'No connection',
        "New barcode scans need an internet connection. Foods you’ve scanned before still work offline.",
        [
          { text: 'Cancel', style: 'cancel', onPress: resume },
          {
            text: 'Retry',
            onPress: () => {
              busy.current = false;
              handleCode(code);
            },
          },
        ]
      );
    }
  };

  // Still loading the current status: render a blank surface rather than
  // flashing the "needs camera access" screen for a frame before the real
  // status (or the OS dialog) arrives.
  if (!permission) return <ThemedView style={styles.permissionRoot} />;

  if (!permission.granted) {
    return (
      <ThemedView style={styles.permissionRoot}>
        <SafeAreaView style={styles.permissionContent}>
          <ThemedText type="default" style={styles.permissionText}>
            MacroTrack needs camera access to scan barcodes.
          </ThemedText>
          {permission.canAskAgain ? (
            <Pressable
              style={[styles.primaryButton, { backgroundColor: theme.tintSolid }]}
              onPress={requestPermission}>
              <ThemedText type="smallBold" style={styles.primaryButtonText}>
                Allow camera
              </ThemedText>
            </Pressable>
          ) : (
            // The OS will not show its dialog again, so telling the user to
            // "enable it in settings" without a way to get there is a dead end:
            // openSettings() drops them on this app's own settings page.
            <>
              <ThemedText type="small" themeColor="textSecondary" style={styles.permissionText}>
                Camera access is off. Turn it on in Settings, or type the barcode below.
              </ThemedText>
              <Pressable
                style={[styles.primaryButton, { backgroundColor: theme.tintSolid }]}
                onPress={() => Linking.openSettings()}>
                <ThemedText type="smallBold" style={styles.primaryButtonText}>
                  Open Settings
                </ThemedText>
              </Pressable>
            </>
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
        style={[styles.primaryButton, { backgroundColor: theme.tintSolid }]}
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
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: 16,
  },
  primaryButton: {
    borderRadius: Radius.control,
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
