#!/data/data/com.termux/files/usr/bin/bash
# One-shot installer for inception-bridge on native Termux.
# Usage:  bash termux-install.sh
set -e
echo "==> updating packages (first run may take a while)"
pkg update -y
echo "==> installing nodejs + native chromium (~160MB download)"
pkg install -y nodejs-lts chromium
echo "==> solving Vercel checkpoint with Termux chromium (auto-capture session)"
node warmup.mjs --output creds.json
echo ""
echo "DONE. Start the bridge with:"
echo "  node server.mjs --auto-refresh 5"
echo ""
echo "Then test in another terminal (or after Ctrl+C):"
echo "  node test.mjs --stream --verbose"
