#!/usr/bin/env python3
"""Applies app name, permissions and (optionally) bundle id to the generated
android/ and ios/ folders. Run by tool/setup.sh."""
import os
import plistlib
import re
import sys

APP_NAME = "הרב יוסף דנון"
BUNDLE_ID = os.environ.get("BUNDLE_ID", "").strip()

# ---------- Android ----------
manifest = "android/app/src/main/AndroidManifest.xml"
if os.path.exists(manifest):
    s = open(manifest, encoding="utf-8").read()
    if "android.permission.INTERNET" not in s:
        s = s.replace(
            "<application",
            '<uses-permission android:name="android.permission.INTERNET"/>\n    <application',
            1,
        )
    s = re.sub(r'android:label="[^"]*"', f'android:label="{APP_NAME}"', s, count=1)
    open(manifest, "w", encoding="utf-8").write(s)
    print("✓ AndroidManifest: internet permission + app name")
else:
    print("! AndroidManifest not found", file=sys.stderr)

if BUNDLE_ID:
    for gradle in ("android/app/build.gradle.kts", "android/app/build.gradle"):
        if os.path.exists(gradle):
            s = open(gradle, encoding="utf-8").read()
            s = re.sub(r'(applicationId\s*=?\s*)"[^"]*"', rf'\1"{BUNDLE_ID}"', s)
            open(gradle, "w", encoding="utf-8").write(s)
            print(f"✓ Android applicationId = {BUNDLE_ID}")

# ---------- iOS ----------
plist_path = "ios/Runner/Info.plist"
if os.path.exists(plist_path):
    with open(plist_path, "rb") as f:
        p = plistlib.load(f)
    p["CFBundleDisplayName"] = APP_NAME
    # needed when the admin page opens the photo library / camera to pick a video
    p["NSPhotoLibraryUsageDescription"] = "בחירת סרטונים להעלאה לאתר"
    p["NSCameraUsageDescription"] = "צילום סרטון להעלאה לאתר"
    p["NSMicrophoneUsageDescription"] = "הקלטת קול בסרטון להעלאה לאתר"
    p["LSApplicationQueriesSchemes"] = sorted(
        set(p.get("LSApplicationQueriesSchemes", [])) | {"whatsapp", "tel", "https"}
    )
    with open(plist_path, "wb") as f:
        plistlib.dump(p, f)
    print("✓ Info.plist: app name + usage descriptions")
else:
    print("! Info.plist not found", file=sys.stderr)

if BUNDLE_ID:
    pbx = "ios/Runner.xcodeproj/project.pbxproj"
    if os.path.exists(pbx):
        s = open(pbx, encoding="utf-8").read()
        # keep the RunnerTests suffix on the test target
        s = re.sub(
            r"PRODUCT_BUNDLE_IDENTIFIER = [^;]*?(\.RunnerTests)?;",
            lambda m: f"PRODUCT_BUNDLE_IDENTIFIER = {BUNDLE_ID}{m.group(1) or ''};",
            s,
        )
        open(pbx, "w", encoding="utf-8").write(s)
        print(f"✓ iOS bundle id = {BUNDLE_ID}")
