# Path to launch (App Store / Play Store)

Captured for later — **not started**. The app currently runs as an EAS
dev/preview build for personal use, which needs none of this. The steps below
are only for distributing to *other people* via the stores.

## Build mechanism (already set up)

`eas.json` has a `production` profile. Builds run in the cloud (no Mac needed,
even for iOS):

- Android: `eas build --profile production --platform android` → `.aab`
- iOS: `eas build --profile production --platform ios` → `.ipa`
- Upload: `eas submit --platform android|ios`

## Prerequisites specific to this app (do before either store)

- [ ] **Real model hosting.** The ~1.9 GB GGUF is downloaded at runtime from a
      GitHub release — fine for personal scale, not a real CDN. Move to proper
      hosting (HF, R2/S3, a CDN) and update `MODEL_BASE_URL` in
      `mobile/src/lib/ai/local-model.ts`.
- [ ] **Model license check.** Confirm the shipped model's license (Qwen2.5 /
      the retrained small model) permits app distribution for the intended use
      (personal vs commercial).
- [ ] **Data attribution.** Add credits for USDA FoodData Central (public
      domain) and Open Food Facts (ODbL) — both allow commercial use.
- [ ] **Real app icon + splash** (currently the Expo placeholder).
- [ ] Polish pass, and confirm the on-device model is good enough to ship.

## Google Play Store

- [ ] Google Play Developer account — **$25 one-time**.
- [ ] Build `.aab`; create the app in Play Console (title, description,
      screenshots, feature graphic, content rating).
- [ ] **Data Safety** form — easy here: local-first, no accounts, on-device AI,
      minimal/no data collection.
- [ ] **New-account gate:** personal accounts created recently must run a
      **closed test with 20 testers for 14 days** before production is unlocked.
- [ ] `eas submit --platform android`; review is hours–days.

## Apple App Store

- [ ] Apple Developer Program — **$99/year** (recurring).
- [ ] Build `.ipa`; create the app in App Store Connect (listing, screenshots
      at multiple device sizes, privacy "nutrition label").
- [ ] Beta via **TestFlight** before the public release.
- [ ] `eas submit --platform ios`; **App Review** is stricter, ~1–3 days.

## Notes

- **Privacy is a selling point**, not a hurdle: local-first, no accounts, data
  stays on device, AI runs on-device. Both stores' privacy forms are honest and
  minimal. (Barcode scans hit Open Food Facts; that's the only network call.)
- A macro tracker is **fitness/nutrition, not a medical device** — no special
  regulatory hurdles. Avoid medical claims.
- **Testing on a physical iPhone** needs a Mac (free Apple ID, 7-day re-signing
  via Xcode) or the $99 program (EAS + TestFlight/ad-hoc). No free cloud path
  from Windows. See the Android dev-build flow, which *is* free to sideload.
- **You don't need the stores for personal use** — keep using EAS dev/preview
  builds on your own devices.

## Rough sequence

1. Finish the small text model + wire it in.
2. Real icon + polish + proper model hosting.
3. Beta: Play internal testing / TestFlight.
4. Public store release once it's solid.
