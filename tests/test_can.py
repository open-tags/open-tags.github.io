"""CAN decoder and freshness tests. No CAN interface or module is opened."""

import argparse
import contextlib
import hashlib
import io
import runpy
import struct
import tempfile
import unittest
from pathlib import Path

import cantools

CAN = runpy.run_path(str(Path(__file__).resolve().parents[1] / "docs/can/opentags_can.py"))
decode = CAN["decode_frame"]
PATCHER = runpy.run_path(str(Path(__file__).resolve().parents[1] / "docs/can/set_can_node.py"))


class CanTests(unittest.TestCase):
    def test_range_matches_firmware_golden_vector(self):
        value = decode(0x501, bytes.fromhex("132ae60b000014fd"))
        self.assertEqual(value, {"type": "range", "node_id": 1, "sequence": 42,
                                "valid": True, "distance_m": 3.046, "rssi_dbm": -74.8})

    def test_dbc_matches_firmware_and_python_vectors(self):
        database = cantools.database.load_file(
            Path(__file__).resolve().parents[1] / "docs/can/opentags-range-v1.dbc")
        self.assertEqual({message.frame_id for message in database.messages}, {0x501, 0x541})
        for message in database.messages:
            self.assertEqual(message.length, 8)
            self.assertFalse(message.is_extended_frame)
            self.assertFalse(message.is_fd)
        value = database.decode_message(0x501, bytes.fromhex("132ae60b000014fd"), decode_choices=False)
        self.assertEqual(value["ProtocolVersion"], 1)
        self.assertEqual(value["RangeValid"], 1)
        self.assertEqual(value["RssiValid"], 1)
        self.assertEqual(value["Sequence"], 42)
        self.assertAlmostEqual(value["Distance"], 3.046)
        self.assertAlmostEqual(value["FirstPathPower"], -74.8)
        status = database.decode_message(0x541, bytes.fromhex("01011900e8030000"), decode_choices=False)
        self.assertEqual(status["RangeFresh"], 1)
        self.assertEqual(status["LastValidAge"], 25)
        self.assertEqual(status["Uptime"], 1000)

    def test_invalid_is_none_not_zero(self):
        value = decode(0x53F, bytes.fromhex("10ffffffffff ff7f"))
        self.assertEqual(value["node_id"], 63)
        self.assertFalse(value["valid"])
        self.assertIsNone(value["distance_m"])
        self.assertIsNone(value["rssi_dbm"])
        self.assertEqual(decode(0x501, bytes.fromhex("110000000000ff7f"))["distance_m"], 0)

    def test_status_matches_firmware_golden_vector(self):
        value = decode(0x541, bytes.fromhex("01011900e8030000"))
        self.assertTrue(value["fresh"])
        self.assertEqual(value["last_valid_age_ms"], 25)
        self.assertEqual(value["uptime_ms"], 1000)
        value = decode(0x57F, bytes.fromhex("0106ffff01000000"))
        self.assertIsNone(value["last_valid_age_ms"])
        self.assertTrue(value["tx_dropped"])
        self.assertTrue(value["error_passive"])

    def test_reject_bad_lengths_versions_and_sentinels(self):
        cases = [(0x501, b""), (0x501, bytes(9)),
                 (0x501, bytes.fromhex("232ae60b000014fd")),
                 (0x501, bytes.fromhex("172ae60b000014fd")),
                 (0x501, bytes.fromhex("1300ffffffff14fd")),
                 (0x501, bytes.fromhex("1300e8030000ff7f")),
                 (0x501, bytes.fromhex("1000e8030000ff7f")),
                 (0x541, bytes.fromhex("0200000000000000")),
                 (0x541, bytes.fromhex("0108000000000000")),
                 (0x541, bytes.fromhex("0101fb0000000000"))]
        for can_id, payload in cases:
            with self.subTest(can_id=can_id, payload=payload):
                with self.assertRaises(ValueError):
                    decode(can_id, payload)

    def test_socketcan_filters_flags_and_reserved_ids(self):
        payload = bytes.fromhex("132ae60b000014fd")
        for can_id in [0x123, 0x500, 0x540, 0x580, 0x800, -1]:
            self.assertIsNone(decode(can_id, payload))
        for flag in [CAN["CAN_EFF_FLAG"], CAN["CAN_RTR_FLAG"], CAN["CAN_ERR_FLAG"]]:
            self.assertIsNone(CAN["decode_socketcan"](struct.pack("=IB3x8s", flag | 0x501, 8, payload)))
        value = CAN["decode_socketcan"](struct.pack("=IB3x8s", 0x501, 8, payload))
        self.assertEqual(value["distance_m"], 3.046)
        for packet in [b"", bytes(72), struct.pack("=IB3x8s", 0x501, 7, payload)]:
            with self.assertRaises(ValueError):
                CAN["decode_socketcan"](packet)

    def test_heartbeats_do_not_keep_missing_ranges_fresh(self):
        health = CAN["Freshness"](started_at=0)
        health.observe({"type": "range", "valid": True}, 1)
        self.assertFalse(health.stale(1.25))
        health.observe({"type": "status", "fresh": True}, 1.3)
        self.assertTrue(health.stale(1.3))
        health.observe({"type": "range", "valid": True}, 1.4)
        self.assertFalse(health.stale(1.4))
        health.observe({"type": "range", "valid": False}, 1.41)
        self.assertTrue(health.stale(1.41))

    def test_stale_heartbeat_and_no_samples(self):
        health = CAN["Freshness"](started_at=0)
        self.assertTrue(health.stale(0.251))
        health.observe({"type": "range", "valid": True}, 1)
        health.observe({"type": "status", "fresh": False}, 1.01)
        self.assertTrue(health.stale(1.01))

    def test_cli_node_bounds(self):
        for value in ["1", "63"]:
            self.assertEqual(CAN["node_id"](value), int(value))
        for value in ["0", "64", "-1", "abc"]:
            with self.assertRaises(argparse.ArgumentTypeError):
                CAN["node_id"](value)

    def test_node_patcher_changes_only_the_id(self):
        original = b"prefix" + PATCHER["MAGIC"] + struct.pack("<I", 1) + b"suffix"
        changed = PATCHER["patch_image"](original, 63)
        self.assertEqual(changed, b"prefix" + PATCHER["MAGIC"] + struct.pack("<I", 63) + b"suffix")
        self.assertEqual(len(changed), len(original))

    def test_node_patcher_rejects_wrong_images_and_ids(self):
        magic = PATCHER["MAGIC"]
        images = [b"USB-only image", magic, magic + b"\0\0\0\0", (magic + b"\1\0\0\0") * 2]
        for image in images:
            with self.assertRaises(ValueError):
                PATCHER["patch_image"](image, 1)
        for node in [0, 64, -1]:
            with self.assertRaises(ValueError):
                PATCHER["patch_image"](magic + b"\1\0\0\0", node)

    def test_node_patcher_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(PATCHER["MAGIC"] + b"\1\0\0\0")
            original = source.read_bytes()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                PATCHER["main"]([str(source), "--node", "2", "--output", str(source)])
            self.assertEqual(source.read_bytes(), original)

    def test_bench_image_size_vectors_and_node_block(self):
        root = Path(__file__).resolve().parents[1]
        image = (root / "firmware/bins/twr_resp_can.bin").read_bytes()
        self.assertGreater(len(image), 1024)
        self.assertLessEqual(len(image), 128 * 1024, "must fit bank 1; do not write through the flash-bank gap")
        stack, reset = struct.unpack_from("<II", image)
        self.assertTrue(0x20000000 < stack <= 0x20020000)
        self.assertEqual(reset & 1, 1)
        self.assertTrue(0x08000000 <= (reset & ~1) < 0x08000000 + len(image))
        self.assertEqual(image.count(PATCHER["MAGIC"]), 1)
        offset = image.index(PATCHER["MAGIC"]) + len(PATCHER["MAGIC"])
        self.assertEqual(struct.unpack_from("<I", image, offset)[0], 1)
        changed = PATCHER["patch_image"](image, 2)
        self.assertEqual(changed[:offset], image[:offset])
        self.assertEqual(changed[offset + 4:], image[offset + 4:])
        self.assertEqual(image.count(b"OTAG-CALIB-DEF\0\0"), 1)
        self.assertIn(b"twr_resp-can-1", image)
        checksum, filename = (root / "firmware/bins/twr_resp_can.sha256").read_text().split()
        self.assertEqual(filename, "twr_resp_can.bin")
        self.assertEqual(hashlib.sha256(image).hexdigest(), checksum)


if __name__ == "__main__":
    unittest.main()
