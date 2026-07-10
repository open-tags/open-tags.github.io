#!/usr/bin/env python3
"""Read firmware, role, PHY, calibration, and diagnostics from one tag."""

import argparse

from opentag_serial import apply_saved_calibration, open_port, request_info

parser = argparse.ArgumentParser()
parser.add_argument("port", help="serial port, for example /dev/tty.usbmodem1101")
args = parser.parse_args()

with open_port(args.port) as tag:
    info, lines = request_info(tag)
    applied = apply_saved_calibration(tag, info)
    for line in lines:
        print(line)
    if applied is not None:
        print(f"OK applied saved calibration {applied} dtu")
