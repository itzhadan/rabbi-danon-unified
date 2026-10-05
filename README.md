# אפליקציית "הרב יוסף דנון"

אפליקציית Flutter שמציגה את האתר `rabbiyosefdanon.rabbiyosefdanon.workers.dev` במסך מלא:
סמל ומסך פתיחה משלה, נגן הסרטונים של האתר, מסך מלא לסרטון, כפתור "חזרה" של אנדרואיד,
קישורי טלפון / וואטסאפ שנפתחים באפליקציות שלהם, ומסך "אין חיבור" עם ניסיון חוזר.

כל מה שמעלים בדף הניהול מופיע באפליקציה מיד – אין צורך לבנות אותה מחדש.

## בנייה ב-Codemagic

1. מעלים את התיקייה הזו למאגר Git (GitHub / GitLab / Bitbucket) ומחברים אותו ל-Codemagic.
2. Codemagic מזהה את `codemagic.yaml`. יש שני תהליכים:
   - **Android APK** – מפיק `app-release.apk` להתקנה ישירה.
   - **iOS unsigned IPA** – מפיק `rabbi-danon-unsigned.ipa` לא חתום, לחתימה עצמית.
3. לשינוי מזהה האפליקציה (Bundle ID) מוסיפים משתנה סביבה `BUNDLE_ID`, למשל `com.yourname.rabbidanon`.

## בנייה במחשב (Flutter מותקן)

```bash
bash tool/setup.sh              # יוצר את android/ ו-ios/, סמל, מסך פתיחה, הרשאות
flutter build apk --release     # → build/app/outputs/flutter-apk/app-release.apk
```

## מה כדאי לדעת

- תיקיות `android/` ו-`ios/` לא נמצאות במאגר – `tool/setup.sh` יוצר אותן בכל בנייה.
- ה-APK נחתם במפתח ה-debug של מכונת הבנייה. כדי שמשתמשים יוכלו **לעדכן** גרסה בלי להסיר
  את הקודמת, צריך לחתום תמיד באותו keystore (Codemagic → Code signing identities → Android keystores).
- כתובת האתר מוגדרת בראש `lib/main.dart` (`kHomeUrl`, `kSiteHost`).
