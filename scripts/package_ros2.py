"""Build the public ROS 2 source ZIP from an explicit, reviewed file list."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILES = (
    "ros2/LICENSE",
    "ros2/README.md",
    "ros2/opentags_driver/config/driver.yaml",
    "ros2/opentags_driver/launch/driver.launch.py",
    "ros2/opentags_driver/opentags_driver/__init__.py",
    "ros2/opentags_driver/opentags_driver/driver.py",
    "ros2/opentags_driver/opentags_driver/protocol.py",
    "ros2/opentags_driver/opentags_driver/transport.py",
    "ros2/opentags_driver/package.xml",
    "ros2/opentags_driver/resource/opentags_driver",
    "ros2/opentags_driver/setup.cfg",
    "ros2/opentags_driver/setup.py",
    "ros2/opentags_driver/test/test_driver_loopback.py",
    "ros2/opentags_driver/test/test_protocol.py",
    "ros2/opentags_driver/test/test_transport.py",
    "ros2/opentags_msgs/CMakeLists.txt",
    "ros2/opentags_msgs/msg/PositionMeasurement.msg",
    "ros2/opentags_msgs/msg/RangeMeasurement.msg",
    "ros2/opentags_msgs/package.xml",
)


def write_archive(destination):
    """Include source only; never collect workspace outputs or private siblings."""
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in SOURCE_FILES:
            info = ZipInfo(name)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())


if __name__ == "__main__":
    destination = ROOT / "docs/ros2/opentags-ros2.zip"
    write_archive(destination)
    print(f"Packaged {len(SOURCE_FILES)} ROS 2 source files: {destination.relative_to(ROOT)}")
