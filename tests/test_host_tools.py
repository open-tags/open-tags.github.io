"""Host-side regressions using fake serial/DFU devices, never physical hardware."""

import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "docs/scripts"
sys.path.insert(0, str(SCRIPTS))
import opentag_serial as host


class FakePort:
    def __init__(self, lines=()):
        self.lines = iter(lines)
        self.commands = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def write(self, data):
        self.commands.append(data)

    def flush(self):
        pass

    def readline(self):
        return next(self.lines, b"")


class HostToolsTests(unittest.TestCase):
    def test_ack_ignores_measurements(self):
        tag = FakePort([b"D 42 1000 16000 -700\n", b"OK CALIB 12345\n"])
        host.send_and_expect(tag, "CALIB 12345", "OK CALIB 12345")
        self.assertEqual(tag.commands, [b"CALIB 12345\n"])

    def test_ack_reports_device_error(self):
        with self.assertRaisesRegex(RuntimeError, "bad-int"):
            host.send_and_expect(FakePort([b"ERR bad-int\n"]), "CALIB bad", "OK CALIB bad")

    def test_ack_times_out(self):
        with self.assertRaises(TimeoutError):
            host.send_and_expect(FakePort(), "CALIB 12345", "OK CALIB 12345", timeout=0)

    def test_calibration_collection_has_deadline(self):
        with self.assertRaisesRegex(TimeoutError, "0 of 100"):
            host.collect_samples(FakePort(), count=100, seconds=0)

    def test_collect_complete_sample_count(self):
        samples, events = host.collect_samples(FakePort([b"D 1 1000 16000 -700\n"]), count=1, seconds=1)
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].measured_mm, 1000)
        self.assertEqual(samples[0].rssi_dbm, -70)
        self.assertEqual(events, [])

    def test_saved_offset_requires_ack(self):
        info = {"mode": "R", "id": "test-device"}
        with patch.object(host, "load_calibrations", return_value={"test-device": 12345}):
            with patch.object(host, "send_and_expect") as ack:
                self.assertEqual(host.apply_saved_calibration(FakePort(), info), 12345)
                self.assertEqual(ack.call_args.args[1:], ("CALIB 12345", "OK CALIB 12345"))
            with patch.object(host, "send_and_expect", side_effect=TimeoutError):
                with self.assertRaises(TimeoutError):
                    host.apply_saved_calibration(FakePort(), info)

    def test_calibration_is_not_saved_on_ack_failure(self):
        samples = [host.DistanceSample(0, "", 1, 1000, 16000, -70)] * 10
        with patch.object(sys, "argv", ["calibrate.py", "FAKE", "--true-mm", "1000", "--samples", "10"]), \
             patch.object(host, "open_port", return_value=FakePort()), \
             patch.object(host, "request_info", return_value=({"mode": "R", "id": "test", "calib": "12241"}, [])), \
             patch.object(host, "collect_samples", return_value=(samples, [])), \
             patch.object(host, "send_and_expect", side_effect=TimeoutError), \
             patch.object(host, "save_calibration") as save:
            with self.assertRaises(TimeoutError):
                runpy.run_path(str(SCRIPTS / "calibrate.py"), run_name="__main__")
            save.assert_not_called()

    def test_info_no_restore_does_not_apply_calibration(self):
        with patch.object(sys, "argv", ["info.py", "FAKE", "--no-restore"]), \
             patch.object(host, "open_port", return_value=FakePort()), \
             patch.object(host, "request_info", return_value=({}, [])), \
             patch.object(host, "apply_saved_calibration") as restore:
            runpy.run_path(str(SCRIPTS / "info.py"), run_name="__main__")
            restore.assert_not_called()

    def test_info_checks_value_after_restore(self):
        with patch.object(sys, "argv", ["info.py", "FAKE"]), \
             patch.object(host, "open_port", return_value=FakePort()), \
             patch.object(host, "request_info", side_effect=[({}, []), ({"calib": "0"}, [])]), \
             patch.object(host, "apply_saved_calibration", return_value=12345):
            with self.assertRaisesRegex(SystemExit, "did not confirm"):
                runpy.run_path(str(SCRIPTS / "info.py"), run_name="__main__")

    def test_flash_exit_status_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="opentags-fake-dfu-") as directory:
            folder = Path(directory)
            fake = folder / "dfu-util"
            fake.write_text('#!/bin/sh\nexit "$FAKE_DFU_STATUS"\n')
            fake.chmod(0o755)
            binary = folder / "test.bin"
            binary.write_bytes(b"not a real firmware image")
            for status in (0, 7):
                with self.subTest(status=status):
                    environment = {**os.environ, "PATH": str(folder) + os.pathsep + os.environ["PATH"], "FAKE_DFU_STATUS": str(status)}
                    result = subprocess.run(["bash", str(SCRIPTS / "flash.sh"), "initiator", str(binary)],
                                            input="\n", text=True, capture_output=True, env=environment)
                    self.assertEqual(result.returncode, status, result.stderr)
                    if status:
                        self.assertIn("unconfirmed", result.stderr)
                        self.assertNotIn("completed successfully", result.stdout)
                    else:
                        self.assertIn("completed successfully", result.stdout)


if __name__ == "__main__":
    unittest.main()
