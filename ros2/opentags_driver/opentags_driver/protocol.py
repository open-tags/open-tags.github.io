"""Parser for the newline-delimited OpenTag USB serial protocol.

This module deliberately has no ROS or pyserial dependency, so recorded device
output can be tested and decoded in ordinary Python tooling.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class RangeRecord:
    sequence: int
    distance_m: float
    exchange_time_us: int | None
    rssi_dbm: float | None
    raw: str


@dataclass(frozen=True)
class PositionRecord:
    sequence: int
    x_m: float
    y_m: float
    z_m: float
    raw_tdoa: tuple[int, int, int]
    raw: str


@dataclass(frozen=True)
class MissRecord:
    sequence: int | None
    reason: str
    raw: str


@dataclass(frozen=True)
class DeviceRecord:
    kind: str
    fields: Mapping[str, str]
    raw: str


@dataclass(frozen=True)
class TextRecord:
    kind: str
    raw: str


@dataclass(frozen=True)
class MalformedRecord:
    reason: str
    raw: str


ProtocolRecord = (
    RangeRecord
    | PositionRecord
    | MissRecord
    | DeviceRecord
    | TextRecord
    | MalformedRecord
)


def parse_fields(tokens: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for token in tokens:
        if "=" in token:
            key, value = token.split("=", 1)
            if key:
                fields[key] = value
    return fields


def _sequence(value: str) -> int:
    sequence = int(value)
    if not 0 <= sequence <= 255:
        raise ValueError("sequence is outside uint8 range")
    return sequence


def parse_line(line: str) -> ProtocolRecord:
    """Parse one device line without raising on malformed device input."""

    raw = line.strip()
    if not raw:
        return MalformedRecord("empty line", raw)

    parts = raw.split()
    kind = parts[0].upper()

    try:
        if kind == "D":
            if len(parts) < 3:
                raise ValueError("range record requires sequence and distance")
            sequence = _sequence(parts[1])
            distance_mm = int(parts[2])
            if distance_mm < 0:
                raise ValueError("distance cannot be negative")
            exchange_time_us = int(parts[3]) if len(parts) >= 4 else None
            if exchange_time_us is not None and not 0 <= exchange_time_us <= 0xFFFFFFFF:
                raise ValueError("exchange time is outside uint32 range")
            rssi_dbm = int(parts[4]) / 10.0 if len(parts) >= 5 else None
            return RangeRecord(
                sequence=sequence,
                distance_m=distance_mm / 1000.0,
                exchange_time_us=exchange_time_us,
                rssi_dbm=rssi_dbm,
                raw=raw,
            )

        if kind == "P":
            if len(parts) < 8:
                raise ValueError(
                    "position record requires sequence, xyz, and three raw TDOA values"
                )
            return PositionRecord(
                sequence=_sequence(parts[1]),
                x_m=int(parts[2]) / 1000.0,
                y_m=int(parts[3]) / 1000.0,
                z_m=int(parts[4]) / 1000.0,
                raw_tdoa=(int(parts[5]), int(parts[6]), int(parts[7])),
                raw=raw,
            )

        if kind == "MISS":
            if len(parts) < 3:
                raise ValueError("miss record requires sequence and reason")
            sequence = None if parts[1] == "-" else _sequence(parts[1])
            return MissRecord(sequence=sequence, reason=" ".join(parts[2:]), raw=raw)

        if kind in {"INFO", "DIAG", "PHY"}:
            return DeviceRecord(kind=kind, fields=parse_fields(parts[1:]), raw=raw)

        if kind in {"OK", "ERR", "PONG", "CAL"}:
            return TextRecord(kind=kind, raw=raw)

        return TextRecord(kind="UNKNOWN", raw=raw)
    except (TypeError, ValueError) as error:
        return MalformedRecord(str(error), raw)


def sequence_gap(previous: int | None, current: int) -> int:
    """Return likely missing sequence count, including uint8 wraparound."""

    if previous is None:
        return 0
    advance = (current - previous + 256) % 256
    return advance - 1 if 1 < advance < 128 else 0
