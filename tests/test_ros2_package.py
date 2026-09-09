"""Check the public ROS source and its download without requiring ROS or hardware."""

import ast
import runpy
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
PACKAGER = runpy.run_path(str(ROOT / "scripts/package_ros2.py"))
SOURCE_FILES = set(PACKAGER["SOURCE_FILES"])


class Ros2PackageTests(unittest.TestCase):
    def test_download_matches_reviewed_source(self):
        source_files = {
            path.relative_to(ROOT).as_posix()
            for path in (ROOT / "ros2").rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and ".pytest_cache" not in path.parts
            and path.suffix != ".pyc"
        }
        self.assertEqual(source_files, SOURCE_FILES)
        with ZipFile(ROOT / "docs/ros2/opentags-ros2.zip") as archive:
            self.assertEqual(set(archive.namelist()), SOURCE_FILES)
            self.assertEqual(len(archive.namelist()), len(SOURCE_FILES))
            self.assertIsNone(archive.testzip())
            for name in SOURCE_FILES:
                self.assertEqual(archive.read(name), (ROOT / name).read_bytes(), name)

    def test_archive_is_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.zip"
            PACKAGER["write_archive"](destination)
            self.assertEqual(
                destination.read_bytes(),
                (ROOT / "docs/ros2/opentags-ros2.zip").read_bytes(),
            )

    def test_package_metadata_and_python_syntax(self):
        versions = set()
        for package in ("opentags_driver", "opentags_msgs"):
            manifest = ET.parse(ROOT / "ros2" / package / "package.xml").getroot()
            self.assertEqual(manifest.findtext("name"), package)
            self.assertEqual(manifest.findtext("license"), "Apache-2.0")
            versions.add(manifest.findtext("version"))
        self.assertEqual(versions, {"0.1.0"})
        self.assertIn("Apache License", (ROOT / "ros2/LICENSE").read_text())
        for name in SOURCE_FILES:
            if name.endswith(".py"):
                ast.parse((ROOT / name).read_text(), filename=name)
        for name in (
            "ros2/opentags_driver/resource/opentags_driver",
            "ros2/opentags_driver/launch/driver.launch.py",
            "ros2/opentags_driver/config/driver.yaml",
            "ros2/opentags_msgs/msg/RangeMeasurement.msg",
            "ros2/opentags_msgs/msg/PositionMeasurement.msg",
        ):
            self.assertIn(name, SOURCE_FILES)


if __name__ == "__main__":
    unittest.main()
