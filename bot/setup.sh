#!/usr/bin/env bash
# One-time setup of the WhatsApp → website bot.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "צריך להתקין Node.js (ב-Arch:  sudo pacman -S nodejs npm)"; exit 1; }

echo "מתקין רכיבים…"
npm install --no-fund --no-audit

if [ ! -f config.json ]; then
  read -r -s -p "סיסמת הניהול של האתר (לא תוצג בהקלדה): " PW; echo
  PW="$PW" node -e 'require("fs").writeFileSync("config.json", JSON.stringify({site:"https://rabbiyosefdanon.rabbiyosefdanon.workers.dev", password:process.env.PW}, null, 2))'
  chmod 600 config.json
  echo "✓ config.json נשמר"
fi

command -v ffmpeg >/dev/null || echo "הערה: ffmpeg לא מותקן – הסרטונים יעלו בלי תמונת תצוגה (sudo pacman -S ffmpeg)"

# run automatically in the background, also after a restart
UNIT="$HOME/.config/systemd/user/rabbi-wa-bot.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=Rabbi Danon – WhatsApp to website
After=network-online.target

[Service]
WorkingDirectory=$(pwd)
ExecStart=$(command -v node) bot.mjs
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
UNITEOF
systemctl --user daemon-reload

cat <<'DONE'

✓ ההתקנה הסתיימה.

שלב 1 – חיבור לוואטסאפ (פעם אחת):
    npm start
  יופיע קוד QR. בטלפון של הרב: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסורקים.
  כשכתוב "מחובר לוואטסאפ" – לוחצים Ctrl+C.

שלב 2 – הפעלה קבועה ברקע:
    systemctl --user enable --now rabbi-wa-bot
    loginctl enable-linger "$USER"        # שימשיך לרוץ גם בלי שמחוברים למחשב

לראות מה קורה:
    journalctl --user -u rabbi-wa-bot -f
DONE
