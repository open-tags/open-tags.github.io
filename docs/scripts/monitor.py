#!/usr/bin/env python3
"""Print live ranging records and optionally write a flat CSV log."""

import argparse
import csv
import sys
import time
from contextlib import nullcontext

from opentag_serial import apply_saved_calibration, open_port, parse_distance, read_line, request_info

parser = argparse.ArgumentParser()
parser.add_argument("port")
parser.add_argument("--csv", help="optional output CSV path")
args = parser.parse_args()

with open_port(args.port) as tag:
    info, _ = request_info(tag)
    apply_saved_calibration(tag, info)
    started = time.monotonic()
    output = open(args.csv, "w", newline="", encoding="utf-8") if args.csv else nullcontext(sys.stdout)
    with output as handle:
        writer = csv.writer(handle)
        if args.csv:
            writer.writerow(["elapsed_ms", "timestamp_iso", "seq", "measured_mm", "exchange_us", "rssi_dbm"])
        try:
            while True:
                line = read_line(tag)
                if not line:
                    continue
                sample = parse_distance(line, started)
                if not sample:
                    print(line)
                    continue
                print(f"{sample.measured_mm:6d} mm  seq={sample.seq:3d}  rssi={sample.rssi_dbm}")
                if args.csv:
                    writer.writerow([sample.elapsed_ms, sample.timestamp_iso, sample.seq, sample.measured_mm, sample.exchange_us, sample.rssi_dbm])
                    handle.flush()
        except KeyboardInterrupt:
            pass
