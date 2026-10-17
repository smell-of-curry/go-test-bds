#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP="build/UILabHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# Default swiftc stamps minos 28 while this host is macOS 27; Launch Services then rejects `open` (-10825).
swiftc -O -parse-as-library -target arm64-apple-macosx14.0 \
  -framework AppKit \
  -framework ScreenCaptureKit \
  -framework ApplicationServices \
  -framework Network \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  -o "$APP/Contents/MacOS/UILabHelper" \
  UILabHelper.swift
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>UILabHelper</string>
	<key>CFBundleIdentifier</key>
	<string>com.gotestbds.uilabhelper</string>
	<key>CFBundleName</key>
	<string>UILabHelper</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>UILabHelper drives the Minecraft client window for scripted UI checks.</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSScreenCaptureUsageDescription</key>
	<string>UILabHelper captures the Minecraft client window for scripted UI checks.</string>
</dict>
</plist>
EOF
codesign --force --deep -s - "$APP"
echo "built $APP"
