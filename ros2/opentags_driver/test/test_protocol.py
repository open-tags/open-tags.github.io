import unittest

from opentags_driver.protocol import (
    DeviceRecord,
    MalformedRecord,
    MissRecord,
    PositionRecord,
    RangeRecord,
    TextRecord,
    parse_line,
    sequence_gap,
)


class ProtocolTest(unittest.TestCase):
    def test_full_range_record(self) -> None:
        record = parse_line("D 42 3046 16174 -748")
        self.assertIsInstance(record, RangeRecord)
        self.assertEqual(record.sequence, 42)
        self.assertAlmostEqual(record.distance_m, 3.046)
        self.assertEqual(record.exchange_time_us, 16174)
        self.assertAlmostEqual(record.rssi_dbm, -74.8)

    def test_short_range_record(self) -> None:
        record = parse_line("D 255 812")
        self.assertIsInstance(record, RangeRecord)
        self.assertAlmostEqual(record.distance_m, 0.812)
        self.assertIsNone(record.exchange_time_us)
        self.assertIsNone(record.rssi_dbm)

    def test_position_record_converts_millimetres(self) -> None:
        record = parse_line("P 7 1250 -500 40 811 -22 990")
        self.assertIsInstance(record, PositionRecord)
        self.assertEqual(record.sequence, 7)
        self.assertEqual((record.x_m, record.y_m, record.z_m), (1.25, -0.5, 0.04))
        self.assertEqual(record.raw_tdoa, (811, -22, 990))

    def test_miss_without_sequence(self) -> None:
        record = parse_line("MISS - bad-poll-id")
        self.assertIsInstance(record, MissRecord)
        self.assertIsNone(record.sequence)
        self.assertEqual(record.reason, "bad-poll-id")

    def test_device_fields(self) -> None:
        record = parse_line("INFO mode=R id=abc target_hz=40 drops=0")
        self.assertIsInstance(record, DeviceRecord)
        self.assertEqual(record.kind, "INFO")
        self.assertEqual(record.fields["mode"], "R")
        self.assertEqual(record.fields["id"], "abc")

    def test_status_text(self) -> None:
        record = parse_line("PONG")
        self.assertIsInstance(record, TextRecord)
        self.assertEqual(record.kind, "PONG")

    def test_bad_records_do_not_raise(self) -> None:
        cases = [
            "",
            "D 1",
            "D 900 10",
            "D 1 -3",
            "D x 100",
            "P 1 2 3",
            "MISS 4",
        ]
        for line in cases:
            with self.subTest(line=line):
                self.assertIsInstance(parse_line(line), MalformedRecord)

    def test_sequence_gap_and_wraparound(self) -> None:
        self.assertEqual(sequence_gap(None, 4), 0)
        self.assertEqual(sequence_gap(4, 5), 0)
        self.assertEqual(sequence_gap(4, 8), 3)
        self.assertEqual(sequence_gap(254, 1), 2)
        self.assertEqual(sequence_gap(8, 8), 0)


if __name__ == "__main__":
    unittest.main()
