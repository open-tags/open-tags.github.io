#!/usr/bin/env python3
"""Read firmware, role, PHY, calibration, and diagnostics from one tag."""

import argparse

from opentag_serial import apply_saved_calibration, open_port, request_info

parser = argparse.ArgumentParser()
parser.add_argument("port", help="serial port, for example /dev/tty.usbmodem1101")
parser.add_argument("--no-restore", action="store_true", help="read device state without restoring this computer's saved calibration")
args = parser.parse_args()

with open_port(args.port) as tag:
    info, lines = request_info(tag)
    applied = None if args.no_restore else apply_saved_calibration(tag, info)
    if applied is not None:
        info, lines = request_info(tag)
        if info.get("calib") != str(applied):
            raise SystemExit("Saved calibration was acknowledged, but INFO did not confirm it. Check the device before using this offset.")
    for line in lines:
        print(line)
    if applied is not None:
        print(f"OK applied saved calibration {applied} dtu")
