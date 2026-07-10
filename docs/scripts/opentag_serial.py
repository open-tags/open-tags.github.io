#!/usr/bin/env python3
"""Shared serial and measurement helpers for opentag one host scripts."""

from __future__ import annotations

import csv
import json
import math
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import serial
from serial.tools import list_ports

BAUD_RATE = 115200
MM_PER_DTU = 299_792_458 / 63_897_600
CONFIG_PATH = Path.home() / ".config" / "opentags" / "calibration.json"


@dataclass
class DistanceSample:
    elapsed_ms: float
    timestamp_iso: str
    seq: int
    measured_mm: int
    exchange_us: int | None
    rssi_dbm: float | None


def available_ports() -> list[dict[str, str]]:
    return [
        {
            "device": port.device,
            "description": port.description or "",
            "hwid": port.hwid or "",
        }
        for port in list_ports.comports()
    ]


def open_port(path: str, timeout: float = 0.1) -> serial.Serial:
    return serial.Serial(path, BAUD_RATE, timeout=timeout, write_timeout=1)


def send_command(port: serial.Serial, command: str) -> None:
    port.write((command.strip() + "\n").encode("ascii"))
    port.flush()


def read_line(port: serial.Serial) -> str | None:
    raw = port.readline()
    if not raw:
        return None
    return raw.decode("utf-8", errors="replace").strip()


def read_for(port: serial.Serial, seconds: float) -> list[str]:
    deadline = time.monotonic() + seconds
    lines: list[str] = []
    while time.monotonic() < deadline:
        line = read_line(port)
        if line:
            lines.append(line)
    return lines


def request_info(port: serial.Serial, timeout: float = 0.7) -> tuple[dict[str, str], list[str]]:
    port.reset_input_buffer()
    send_command(port, "INFO")
    lines = read_for(port, timeout)
    info: dict[str, str] = {}
    for line in lines:
        if line.startswith("INFO "):
            info.update(parse_fields(line[5:]))
        elif line.startswith("PHY "):
            info["phy"] = line[4:]
    return info, lines


def parse_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for token in text.split():
        if "=" in token:
            key, value = token.split("=", 1)
            fields[key] = value
    return fields


def parse_distance(line: str, started: float) -> DistanceSample | None:
    parts = line.split()
    if len(parts) < 3 or parts[0] != "D":
        return None
    try:
        seq = int(parts[1])
        measured_mm = int(parts[2])
        exchange_us = int(parts[3]) if len(parts) > 3 else None
        rssi_dbm = int(parts[4]) / 10 if len(parts) > 4 else None
    except ValueError:
        return None
    return DistanceSample(
        elapsed_ms=(time.monotonic() - started) * 1000,
        timestamp_iso=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        seq=seq,
        measured_mm=measured_mm,
        exchange_us=exchange_us,
        rssi_dbm=rssi_dbm,
    )


def collect_samples(port: serial.Serial, *, count: int | None = None, seconds: float | None = None) -> tuple[list[DistanceSample], list[str]]:
    if count is None and seconds is None:
        raise ValueError("count or seconds is required")
    started = time.monotonic()
    samples: list[DistanceSample] = []
    events: list[str] = []
    while True:
        if count is not None and len(samples) >= count:
            break
        if seconds is not None and time.monotonic() - started >= seconds:
            break
        line = read_line(port)
        if not line:
            continue
        sample = parse_distance(line, started)
        if sample:
            samples.append(sample)
        elif line.startswith(("MISS ", "ERR ")):
            events.append(line)
    return samples, events


def sequence_gap(previous: int | None, current: int) -> int:
    if previous is None:
        return 0
    advance = (current - previous + 256) % 256
    return advance - 1 if 1 < advance < 128 else 0


def percentile(values: Iterable[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return math.nan
    if len(ordered) == 1:
        return float(ordered[0])
    index = (len(ordered) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    weight = index - low
    return ordered[low] + (ordered[high] - ordered[low]) * weight


def summarize(samples: list[DistanceSample], true_mm: float) -> dict[str, float | int]:
    if not samples:
        raise ValueError("no distance samples collected")
    measured = [sample.measured_mm for sample in samples]
    errors = [value - true_mm for value in measured]
    abs_errors = [abs(value) for value in errors]
    missing = 0
    previous: int | None = None
    for sample in samples:
        missing += sequence_gap(previous, sample.seq)
        previous = sample.seq
    elapsed = (samples[-1].elapsed_ms - samples[0].elapsed_ms) / 1000
    exchanges = [sample.exchange_us for sample in samples if sample.exchange_us is not None]
    rssis = [sample.rssi_dbm for sample in samples if sample.rssi_dbm is not None]
    expected = len(samples) + missing
    return {
        "sample_count": len(samples),
        "mean_measured_mm": statistics.fmean(measured),
        "mean_error_mm": statistics.fmean(errors),
        "stdev_error_mm": statistics.pstdev(errors),
        "min_measured_mm": min(measured),
        "max_measured_mm": max(measured),
        "p50_abs_error_mm": percentile(abs_errors, 0.50),
        "p95_abs_error_mm": percentile(abs_errors, 0.95),
        "rmse_mm": math.sqrt(statistics.fmean(value * value for value in errors)),
        "actual_rate_hz": (len(samples) - 1) / elapsed if elapsed > 0 else math.nan,
        "missing_sequences": missing,
        "packet_success_pct": 100 * len(samples) / expected if expected else math.nan,
        "mean_exchange_us": statistics.fmean(exchanges) if exchanges else math.nan,
        "p95_exchange_us": percentile(exchanges, 0.95),
        "mean_rssi_dbm": statistics.fmean(rssis) if rssis else math.nan,
        "p05_rssi_dbm": percentile(rssis, 0.05),
    }


def load_calibrations() -> dict[str, int]:
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {str(key): int(value) for key, value in raw.items()}


def save_calibration(device_id: str, offset: int) -> None:
    values = load_calibrations()
    values[device_id] = offset
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(values, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def apply_saved_calibration(port: serial.Serial, info: dict[str, str]) -> int | None:
    if info.get("mode") != "R" or not info.get("id"):
        return None
    offset = load_calibrations().get(info["id"])
    if offset is None:
        return None
    send_command(port, f"CALIB {offset}")
    return offset


def write_static_csv(path: Path, samples: list[DistanceSample], true_mm: float, summary: dict[str, float | int], metadata: dict[str, str | int | float]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["section", "field", "value"])
        for key, value in metadata.items():
            writer.writerow(["metadata", key, value])
        writer.writerow([])
        writer.writerow(["section", "metric", "value", "unit"])
        units = {
            "sample_count": "count", "mean_measured_mm": "mm", "mean_error_mm": "mm",
            "stdev_error_mm": "mm", "min_measured_mm": "mm", "max_measured_mm": "mm",
            "p50_abs_error_mm": "mm", "p95_abs_error_mm": "mm", "rmse_mm": "mm",
            "actual_rate_hz": "Hz", "missing_sequences": "count", "packet_success_pct": "percent",
            "mean_exchange_us": "us", "p95_exchange_us": "us", "mean_rssi_dbm": "dBm", "p05_rssi_dbm": "dBm",
        }
        for key, value in summary.items():
            formatted = f"{value:.3f}" if isinstance(value, float) else value
            writer.writerow(["summary", key, formatted, units[key]])
        writer.writerow([])
        writer.writerow(["elapsed_ms", "timestamp_iso", "seq", "measured_mm", "true_mm", "error_mm", "exchange_us", "rssi_dbm"])
        for sample in samples:
            writer.writerow([
                f"{sample.elapsed_ms:.1f}", sample.timestamp_iso, sample.seq, sample.measured_mm,
                f"{true_mm:.1f}", f"{sample.measured_mm - true_mm:.1f}",
                sample.exchange_us if sample.exchange_us is not None else "",
                sample.rssi_dbm if sample.rssi_dbm is not None else "",
            ])
