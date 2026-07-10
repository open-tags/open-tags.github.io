#!/usr/bin/env python3
"""Run a timed static ranging test and write browser-compatible evidence CSV."""

import argparse
from datetime import datetime, timezone
from pathlib import Path

from opentag_serial import (
    apply_saved_calibration, collect_samples, open_port, request_info,
    send_command, summarize, write_static_csv,
)

parser = argparse.ArgumentParser()
parser.add_argument("port", help="responder serial port")
parser.add_argument("--true-mm", type=float, required=True)
parser.add_argument("--seconds", type=float, default=60)
parser.add_argument("--output", type=Path)
args = parser.parse_args()

if args.true_mm <= 0 or args.seconds <= 0:
    parser.error("--true-mm and --seconds must be positive")

stamp = datetime.now(timezone.utc)
output = args.output or Path(f"opentags-static-{args.true_mm:g}mm-{stamp.strftime('%Y%m%dT%H%M%SZ')}.csv")

with open_port(args.port) as tag:
    info, _ = request_info(tag)
    if info.get("mode") != "R":
        raise SystemExit("Static tests must use the responder serial port.")
    applied = apply_saved_calibration(tag, info)
    send_command(tag, "RESET_STATS")
    tag.reset_input_buffer()
    print(f"Collecting {args.seconds:g} seconds from {args.port}...")
    samples, events = collect_samples(tag, seconds=args.seconds)
    summary = summarize(samples, args.true_mm)
    metadata = {
        "start_time": stamp.isoformat(), "duration_target_s": args.seconds,
        "true_distance_mm": args.true_mm, "tag_id": info.get("id", ""),
        "firmware": info.get("fw", ""), "phy": info.get("phy", ""),
        "responder_calib_dtu": applied if applied is not None else info.get("calib", ""),
        "non_distance_events": len(events),
    }
    write_static_csv(output, samples, args.true_mm, summary, metadata)
    print(f"N={summary['sample_count']}  mean error={summary['mean_error_mm']:.1f} mm  P95={summary['p95_abs_error_mm']:.1f} mm")
    print(f"Rate={summary['actual_rate_hz']:.2f} Hz  packet success={summary['packet_success_pct']:.3f}%")
    print(output)
