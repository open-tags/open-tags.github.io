#!/usr/bin/env python3
"""Read OpenTags range-over-CAN v1 using Linux SocketCAN (Python standard library)."""

import argparse
import json
import socket
import struct
import sys
import time

RANGE_ID_BASE = 0x500
STATUS_ID_BASE = 0x540
CAN_SFF_MASK = 0x7FF
CAN_EFF_FLAG = 0x80000000
CAN_RTR_FLAG = 0x40000000
CAN_ERR_FLAG = 0x20000000
SOCKETCAN_FRAME = struct.Struct("=IB3x8s")


def decode_frame(can_id, data):
    """Return a decoded v1 record; ignore other IDs and reject malformed records.

    Invalid distance/RSSI values are None, never plausible zero measurements.
    CAN identifiers are application-assigned, not CANopen or J1939 addresses.
    """
    if can_id < 0 or can_id > CAN_SFF_MASK:
        return None
    if RANGE_ID_BASE < can_id <= RANGE_ID_BASE + 63:
        kind, node = "range", can_id - RANGE_ID_BASE
    elif STATUS_ID_BASE < can_id <= STATUS_ID_BASE + 63:
        kind, node = "status", can_id - STATUS_ID_BASE
    else:
        return None
    if len(data) != 8:
        raise ValueError("range-over-CAN v1 requires exactly 8 payload bytes")
    if kind == "range":
        flags, sequence, distance_mm, rssi = struct.unpack("<BBIh", data)
        if flags >> 4 != 1 or flags & 0x0C:
            raise ValueError("unsupported range version or reserved flags")
        valid, has_rssi = bool(flags & 1), bool(flags & 2)
        if valid == (distance_mm == 0xFFFFFFFF):
            raise ValueError("distance sentinel contradicts validity flag")
        if (has_rssi and not valid) or has_rssi == (rssi == 0x7FFF):
            raise ValueError("RSSI sentinel contradicts validity flag")
        return {"type": kind, "node_id": node, "sequence": sequence, "valid": valid,
                "distance_m": distance_mm / 1000.0 if valid else None,
                "rssi_dbm": rssi / 10.0 if has_rssi else None}
    version, flags, age_ms, uptime_ms = struct.unpack("<BBHI", data)
    if version != 1 or flags & ~7:
        raise ValueError("unsupported status version or reserved flags")
    fresh = bool(flags & 1)
    if fresh and age_ms > 250:
        raise ValueError("fresh flag contradicts range age")
    return {"type": kind, "node_id": node, "fresh": fresh,
            "tx_dropped": bool(flags & 2), "error_passive": bool(flags & 4),
            "last_valid_age_ms": age_ms if age_ms < 0xFFFF else None,
            "uptime_ms": uptime_ms}


def decode_socketcan(packet):
    if len(packet) != SOCKETCAN_FRAME.size:
        raise ValueError("expected a 16-byte Classical CAN socket record")
    can_id, length, data = SOCKETCAN_FRAME.unpack(packet)
    if can_id & (CAN_EFF_FLAG | CAN_RTR_FLAG | CAN_ERR_FLAG):
        return None
    if length > 8:
        raise ValueError("Classical CAN payload exceeds 8 bytes")
    return decode_frame(can_id, data[:length])


class Freshness:
    """Track actual range arrival; heartbeats cannot keep an old range alive."""

    def __init__(self, started_at, timeout_s=0.250):
        self.started_at = started_at
        self.timeout_s = timeout_s
        self.last_valid_at = None
        self.invalid = False

    def observe(self, record, now):
        if record["type"] == "range":
            self.invalid = not record["valid"]
            if record["valid"]:
                self.last_valid_at = now
        elif record["type"] == "status" and not record["fresh"]:
            self.invalid = True

    def stale(self, now):
        since = self.started_at if self.last_valid_at is None else self.last_valid_at
        return self.invalid or now - since > self.timeout_s


def node_id(value):
    try:
        node = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("node must be an integer from 1 to 63") from error
    if not 1 <= node <= 63:
        raise argparse.ArgumentTypeError("node must be an integer from 1 to 63")
    return node


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", default="can0", help="SocketCAN interface (default: can0)")
    parser.add_argument("--node", type=node_id, default=1, help="configured node ID, 1..63 (default: 1)")
    args = parser.parse_args(argv)
    if not hasattr(socket, "AF_CAN"):
        parser.error("live capture requires Linux with a SocketCAN-compatible adapter")
    mask = CAN_SFF_MASK | CAN_EFF_FLAG | CAN_RTR_FLAG | CAN_ERR_FLAG
    filters = b"".join(struct.pack("=II", base + args.node, mask)
                       for base in (RANGE_ID_BASE, STATUS_ID_BASE))
    health = Freshness(time.monotonic())
    was_stale = False
    try:
        with socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW) as bus:
            bus.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FILTER, filters)
            bus.settimeout(0.1)
            bus.bind((args.interface,))
            while True:
                record = None
                try:
                    record = decode_socketcan(bus.recv(SOCKETCAN_FRAME.size))
                except socket.timeout:
                    pass
                except ValueError as error:
                    print(f"Discarded CAN record: {error}", file=sys.stderr)
                now = time.monotonic()
                if record is not None:
                    health.observe(record, now)
                    print(json.dumps(record), flush=True)
                stale = health.stale(now)
                if stale != was_stale:
                    print(json.dumps({"type": "stale" if stale else "recovered", "node_id": args.node}), flush=True)
                    was_stale = stale
    except KeyboardInterrupt:
        return 0
    except OSError as error:
        print(f"CAN capture failed: {error}. Check interface, adapter, and 500000 bit/s setup.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
