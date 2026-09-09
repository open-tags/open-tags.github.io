# OpenTags ROS 2 packages

This directory contains the ROS 2 integration for OpenTag UWB devices.

- `opentags_msgs` defines lossless range and TDOA position messages.
- `opentags_driver` reads the documented USB serial stream, reconnects after
  device resets, publishes measurements and diagnostics, and exposes basic
  device commands as services.

The packages target ROS 2 Jazzy and use standard `ament_cmake` and
`ament_python` layouts. Parser and serial-loopback tests run before publication.
A full Jazzy workspace build and physical-device acceptance run have not yet
been recorded; see the [integration guide](https://open-tags.com/docs/ros2/).

## Download

[Download the source ZIP](https://open-tags.com/docs/ros2/opentags-ros2.zip) or
[browse the source](https://github.com/open-tags/open-tags.github.io/tree/main/ros2).
Extract the ZIP into an empty workspace. It contains `ros2/opentags_driver`,
`ros2/opentags_msgs`, this README, and the [Apache-2.0 license](LICENSE).
The license applies to these ROS 2 packages, not to the hardware or MCU firmware.

## Build

Install and source ROS 2 Jazzy, with colcon and rosdep available. From the website
repository root or the extracted directory containing `ros2/`:

```bash
rosdep install --from-paths ros2 --ignore-src -r -y
colcon build --base-paths ros2 --symlink-install
source install/setup.bash
```

The OS user must be allowed to open the serial device. On most Linux systems,
add the user to `dialout`, then sign out and back in:

```bash
sudo usermod -a -G dialout "$USER"
```

## Run

For Distance, connect the responder and keep its initiator powered. For Location,
complete the anchor survey and configuration, then connect the mobile tag.
Disconnect the browser and other serial readers before launching the driver:

```bash
ros2 launch opentags_driver driver.launch.py port:=/dev/ttyACM0
```

Use a stable `/dev/serial/by-id/...` path in a deployed robot. Parameters can
also be loaded from the included YAML file. From the workspace root:

```bash
ros2 run opentags_driver opentags_driver --ros-args \
  --params-file ros2/opentags_driver/config/driver.yaml \
  -p port:=/dev/serial/by-id/your-opentag
```

## Topics

| Topic | Type | Description |
| --- | --- | --- |
| `/opentags/range` | `opentags_msgs/msg/RangeMeasurement` | Distance in metres, sequence, exchange time, and the legacy RSSI field (first-path power). |
| `/opentags/position` | `geometry_msgs/msg/PointStamped` | TDOA position in metres. |
| `/opentags/position_raw` | `opentags_msgs/msg/PositionMeasurement` | Position plus sequence and raw TDOA values. |
| `/opentags/events` | `std_msgs/msg/String` | `INFO`, `DIAG`, `PHY`, `MISS`, `OK`, and error records. |
| `/diagnostics` | `diagnostic_msgs/msg/DiagnosticArray` | Connection, freshness, parser, sequence, and device health. |

TDOA position uses the surveyed anchor geometry configured for the target
environment. Message timestamps are host receipt times, not radio timestamps.
The driver does not restore browser/Python calibration, configure anchors, or
publish TF transforms. Verify calibration before starting ROS; `frame_id` labels
the measurements but does not transform them into your robot's map.

### Optional `sensor_msgs/Range`

Set `publish_sensor_range:=true` to also publish `/opentags/range_sensor`.
ROS 2 currently defines only ultrasound and infrared radiation enums in
`sensor_msgs/Range`, so this mapping is disabled by default. Consumers that
need correct UWB semantics should use `opentags_msgs/msg/RangeMeasurement`.

```bash
ros2 launch opentags_driver driver.launch.py \
  port:=/dev/ttyACM0 publish_sensor_range:=true
```

## Services

The node exposes three `std_srvs/srv/Trigger` services. A successful response
means the command was written to the connected serial device; device replies
are published on `/opentags/events`.

```bash
ros2 service call /opentags_driver/ping std_srvs/srv/Trigger
ros2 service call /opentags_driver/request_info std_srvs/srv/Trigger
ros2 service call /opentags_driver/reset_statistics std_srvs/srv/Trigger
```

`request_info` works with both modes. `ping` and `reset_statistics` are Distance
commands and return an error on the current Location tag. `reset_statistics`
resets the driver's host-side counters when the command is sent; check the device
reply to confirm its counters were reset.

## Parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `port` | `/dev/ttyACM0` | Serial path or pyserial URL. |
| `baud_rate` | `115200` | USB serial rate. |
| `frame_id` | `opentag` | Frame on published measurements. |
| `reconnect_interval_s` | `2.0` | Delay between open attempts. |
| `stale_after_s` | `2.0` | Measurement age that raises a diagnostic warning. |
| `request_info_on_connect` | `true` | Send `INFO` after each connection. |
| `publish_sensor_range` | `false` | Enable the generic compatibility topic. |

All topic names and generic range metadata are parameters; see
`opentags_driver/config/driver.yaml` for the complete set.

## Protocol coverage

The parser accepts the current full range record and the shorter legacy range
record, along with TDOA position and device status lines:

```text
D <seq> <millimetres> [exchange_us] [rssi_tenths_dbm]
P <seq> <x_mm> <y_mm> <z_mm> <raw_1> <raw_2> <raw_3>
MISS <seq|-> <reason>
INFO ...
DIAG ...
PHY ...
```

Malformed device lines are counted and discarded without terminating the
node. Sequence-gap estimates are ambiguous across long outages and device resets.

## Test

The protocol tests do not require ROS:

```bash
PYTHONPATH=ros2/opentags_driver \
  python3 -m unittest discover -s ros2/opentags_driver/test \
  -p 'test_protocol.py' -v
```

After installing `pyserial`, run the transport loopback test with the same
command and `-p 'test_transport.py'`.

In a ROS 2 workspace, run the package tests with:

```bash
colcon test --packages-select opentags_msgs opentags_driver
colcon test-result --verbose
```

## Maintainers

The public `ros2/` directory is the source for the downloadable package. After
editing it, rebuild the ZIP from the website repository root:

```bash
python3 scripts/package_ros2.py
```

The website tests check that the download matches these source files and contains
only the listed ROS 2 files. No hardware or MCU firmware source is bundled.
