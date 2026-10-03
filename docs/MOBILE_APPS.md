# iOS and Android apps

The mobile apps are built with [Capacitor](https://capacitorjs.com). The same screens as the
website (`public/`) are packaged into native iOS and Android apps, so every feature works the
same way: upload Excel, validation, English/Telugu messages, sending, live progress, retries,
exports, history and the audit log.

```
mobile/
  capacitor.config.json   app id, name, settings
  scripts/build-web.js    copies ../public into www/ and adds an app-specific CSP
  android/                Android Studio project (generated, committed)
  ios/                    Xcode project (generated, committed, Swift Package Manager)
  assets/                 source icon + splash (generate sizes with @capacitor/assets)
```

## How the app works

- **The server stays the same.** Sending, retries, queueing and webhooks all run on the server,
  so a phone that is locked, offline or uninstalled never affects a batch.
- **Server address.** On first launch the app asks for the server address (must be `https://`),
  then the username and password. Use the same accounts, roles and permissions as the website.
- **Sign-in.** The app gets a bearer token (default lifetime 7 days, `MOBILE_SESSION_TTL_HOURS`)
  instead of the website's cookie. Disabling a user on the server signs them out of the app as well.
- **Excel upload.** Tapping the upload box opens the phone's file picker (Files, Google Drive,
  downloads, email attachments).
- **Exports and the template.** Excel and PDF files open in the share sheet (save to Files,
  send on WhatsApp or email, and so on).
- **Live progress.** The dashboard updates live and reconnects automatically after the phone
  is unlocked.

## Server requirements

1. **The server must be deployed and reachable over HTTPS** from phones (e.g. Render, Railway, a VM
   with TLS). The app cannot use `http://` or `localhost`.
2. `CORS_ORIGINS` must include the app origins. The default already does:
   `capacitor://localhost` (iOS) and `https://localhost` (Android).
3. Optional: `MOBILE_SESSION_TTL_HOURS` (default `168`).

## Building

### On GitHub (no Mac or Android Studio needed)

The **Mobile apps** workflow (`.github/workflows/mobile.yml`) runs on every change to `mobile/` or
`public/` and can be started manually from the Actions tab:

| Artifact | What it is |
| --- | --- |
| `payment-reminders-android-debug-apk` | Installable APK for testing. Copy it to an Android phone and open it (allow "install unknown apps") |
| `payment-reminders-android-release-aab` | Signed bundle for Google Play. Built only when the signing secrets below are set |
| `payment-reminders-ios-simulator-app` | Simulator build. Proves the iOS project compiles; it cannot be installed on an iPhone |

### Locally

```bash
cd mobile
npm ci
npm run android        # copies the web UI, syncs, opens Android Studio (Run ▶ on a phone/emulator)
npm run ios            # macOS + Xcode only: opens Xcode (choose a team under Signing, then Run ▶)
```

Run `npm run sync` after every change to `public/`.

## Publishing

### Google Play (Android)

1. Create a Google Play developer account (one-time fee).
2. Create an upload keystore once and keep it safe:
   `keytool -genkey -v -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`
3. Add repository secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 upload.keystore`),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
4. Run the **Mobile apps** workflow, download the `.aab` and upload it in Play Console (start with
   *Internal testing*). The version code comes from the workflow run number.
5. Fill in the store listing, privacy policy URL, Data safety form (the app handles customer names,
   phone numbers and amounts, sent to your own server only) and content rating.

### App Store (iOS)

1. Join the Apple Developer Program (annual fee) and create the app in App Store Connect with bundle
   id `com.lendingdesk.paymentreminders`, or change `appId` in `capacitor.config.json` first.
2. On a Mac: `cd mobile && npm run ios`, set the Team under *Signing & Capabilities*, then
   *Product → Archive → Distribute App* to upload to TestFlight. Automating this in GitHub Actions
   needs an App Store Connect API key and signing certificate as secrets (e.g. with fastlane); this
   is not set up yet.
3. Provide a privacy policy URL and App Privacy answers. Because the app is for your staff only,
   consider **Apple Business Manager / unlisted distribution** or TestFlight instead of a public listing;
   Apple may reject internal-only business apps from the public store.

### Before the first release

- Change `appId` / `appName` in `mobile/capacitor.config.json` to your own domain and brand. The
  app id cannot change after the first store release.
- Replace `mobile/assets/*.png` if you want a different icon/splash, then run
  `npx @capacitor/assets generate --iconBackgroundColor '#1f6f50' --splashBackgroundColor '#f5f7f6'`.
