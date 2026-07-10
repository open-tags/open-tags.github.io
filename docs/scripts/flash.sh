#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <initiator|responder> [firmware.bin]" >&2
  exit 2
}

ROLE=${1:-}
case "$ROLE" in
  initiator) DEFAULT_URL="https://open-tags.com/firmware/bins/twr_init.bin" ;;
  responder) DEFAULT_URL="https://open-tags.com/firmware/bins/twr_resp.bin" ;;
  *) usage ;;
esac

command -v dfu-util >/dev/null || { echo "dfu-util is required." >&2; exit 1; }
TMP=""
BIN=${2:-}
if [[ -z "$BIN" ]]; then
  TMP=$(mktemp -t opentags-firmware.XXXXXX.bin)
  trap 'rm -f "$TMP"' EXIT
  BIN=$TMP
  if command -v curl >/dev/null; then
    curl -fL "$DEFAULT_URL" -o "$BIN"
  elif command -v wget >/dev/null; then
    wget -O "$BIN" "$DEFAULT_URL"
  else
    echo "curl or wget is required to download firmware." >&2
    exit 1
  fi
fi

echo "Hold BOOT0, plug in the tag, then press Enter."
read -r
dfu-util -d 0483:df11 -a 0 --dfuse-address 0x08000000:leave -D "$BIN" || true
echo "Unplug the tag, release BOOT0, and reconnect normally."
if [[ "$ROLE" == "responder" ]]; then
  echo "The responder image contains the default calibration. Run calibrate.py or connect with the browser console to reapply the saved pair offset."
fi
