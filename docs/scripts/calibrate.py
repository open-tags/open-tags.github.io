#!/usr/bin/env python3
"""Calibrate a responder at a known distance and remember the offset by ID."""

import argparse
import math
import statistics

from opentag_serial import MM_PER_DTU, collect_samples, open_port, request_info, save_calibration, send_command

parser = argparse.ArgumentParser()
parser.add_argument("port", help="responder serial port")
parser.add_argument("--true-mm", type=float, required=True)
parser.add_argument("--samples", type=int, default=100)
args = parser.parse_args()

if args.samples < 10 or args.true_mm <= 0:
    parser.error("--samples must be at least 10 and --true-mm must be positive")

with open_port(args.port) as tag:
    info, _ = request_info(tag)
    if info.get("mode") != "R" or not info.get("id") or info.get("calib") in (None, "-"):
        raise SystemExit("Selected port is not a responder with calibration metadata.")
    current = int(info["calib"])
    samples, events = collect_samples(tag, count=args.samples)
    ordered = sorted(sample.measured_mm for sample in samples)
    trimmed = ordered[math.floor(len(ordered) * 0.1):math.ceil(len(ordered) * 0.9)]
    mean_mm = statistics.fmean(trimmed)
    delta_dtu = (mean_mm - args.true_mm) / MM_PER_DTU
    new_offset = math.floor(current + delta_dtu + 0.5)
    send_command(tag, f"CALIB {new_offset}")
    save_calibration(info["id"], new_offset)
    print(f"Mean={mean_mm:.1f} mm  True={args.true_mm:.1f} mm  Delta={delta_dtu:.1f} dtu")
    print(f"Calibration={new_offset} dtu (was {current}); saved for {info['id']}")
    if events:
        print(f"Non-distance events during collection: {len(events)}")
