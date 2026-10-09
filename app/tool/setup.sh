#!/usr/bin/env bash
# Creates the android/ and ios/ folders and applies the app's name, icon,
# splash screen and permissions. Safe to run again.
#
#   bash tool/setup.sh
#
# Optional:  BUNDLE_ID=com.yourcompany.rabbidanon bash tool/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ORG="${APP_ORG:-com.rabbidanon}"

# keep our own files safe while the platform folders are generated
cp lib/main.dart /tmp/_main.dart.bak
cp pubspec.yaml /tmp/_pubspec.yaml.bak

flutter create --platforms=android,ios --org "$ORG" --project-name rabbi_danon .

cp /tmp/_main.dart.bak lib/main.dart
cp /tmp/_pubspec.yaml.bak pubspec.yaml
rm -rf test

python3 tool/patch.py

flutter pub get
dart run flutter_launcher_icons
dart run flutter_native_splash:create

echo
echo "✓ הפרויקט מוכן.  Android:  flutter build apk --release"
echo "               iOS:      flutter build ios --release --no-codesign"
