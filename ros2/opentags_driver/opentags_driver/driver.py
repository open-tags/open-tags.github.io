"""ROS 2 node for OpenTag UWB range and TDOA position data."""

from __future__ import annotations

import queue
import time
from collections.abc import Callable

import rclpy
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from geometry_msgs.msg import PointStamped
from opentags_msgs.msg import PositionMeasurement, RangeMeasurement
from rclpy.node import Node
from rclpy.parameter import Parameter
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Range
from std_msgs.msg import String
from std_srvs.srv import Trigger

from .protocol import (
    DeviceRecord,
    MalformedRecord,
    MissRecord,
    PositionRecord,
    RangeRecord,
    TextRecord,
    parse_line,
    sequence_gap,
)
from .transport import ConnectionState, SerialLine, SerialTransport


class OpenTagsDriver(Node):
    """Bridge OpenTag USB serial records to typed ROS 2 topics."""

    def __init__(self, *, parameter_overrides: list[Parameter] | None = None) -> None:
        super().__init__(
            "opentags_driver",
            parameter_overrides=parameter_overrides,
        )

        self.declare_parameter("port", "/dev/ttyACM0")
        self.declare_parameter("baud_rate", 115200)
        self.declare_parameter("frame_id", "opentag")
        self.declare_parameter("reconnect_interval_s", 2.0)
        self.declare_parameter("serial_timeout_s", 0.1)
        self.declare_parameter("stale_after_s", 2.0)
        self.declare_parameter("request_info_on_connect", True)
        self.declare_parameter("publish_sensor_range", False)
        self.declare_parameter("sensor_range_radiation_type", 0)
        self.declare_parameter("sensor_range_field_of_view", 0.0)
        self.declare_parameter("sensor_range_min_m", 0.05)
        self.declare_parameter("sensor_range_max_m", 60.0)
        self.declare_parameter("range_topic", "opentags/range")
        self.declare_parameter("sensor_range_topic", "opentags/range_sensor")
        self.declare_parameter("position_topic", "opentags/position")
        self.declare_parameter("position_raw_topic", "opentags/position_raw")
        self.declare_parameter("events_topic", "opentags/events")

        self._port = str(self.get_parameter("port").value)
        self._frame_id = str(self.get_parameter("frame_id").value)
        self._stale_after_s = float(self.get_parameter("stale_after_s").value)
        self._request_info_on_connect = bool(self.get_parameter("request_info_on_connect").value)
        self._publish_sensor_range = bool(self.get_parameter("publish_sensor_range").value)

        self._range_publisher = self.create_publisher(
            RangeMeasurement,
            str(self.get_parameter("range_topic").value),
            qos_profile_sensor_data,
        )
        self._position_publisher = self.create_publisher(
            PointStamped,
            str(self.get_parameter("position_topic").value),
            qos_profile_sensor_data,
        )
        self._position_raw_publisher = self.create_publisher(
            PositionMeasurement,
            str(self.get_parameter("position_raw_topic").value),
            qos_profile_sensor_data,
        )
        self._event_publisher = self.create_publisher(
            String,
            str(self.get_parameter("events_topic").value),
            20,
        )
        self._diagnostic_publisher = self.create_publisher(DiagnosticArray, "/diagnostics", 10)

        self._sensor_range_publisher = None
        if self._publish_sensor_range:
            self._sensor_range_publisher = self.create_publisher(
                Range,
                str(self.get_parameter("sensor_range_topic").value),
                qos_profile_sensor_data,
            )
            self.get_logger().warning(
                "sensor_msgs/Range has no UWB radiation enum; "
                "the configured value is an application mapping"
            )

        self._connected = False
        self._connection_message = "starting"
        self._device_fields: dict[str, str] = {}
        self._last_record_time: float | None = None
        self._last_range: RangeRecord | None = None
        self._last_position: PositionRecord | None = None
        self._previous_range_sequence: int | None = None
        self._previous_position_sequence: int | None = None
        self._range_count = 0
        self._position_count = 0
        self._miss_count = 0
        self._malformed_count = 0
        self._missing_range_sequences = 0
        self._missing_position_sequences = 0

        self._transport = SerialTransport(
            port=self._port,
            baud_rate=int(self.get_parameter("baud_rate").value),
            timeout_s=float(self.get_parameter("serial_timeout_s").value),
            reconnect_interval_s=float(self.get_parameter("reconnect_interval_s").value),
        )

        self.create_service(Trigger, "~/ping", self._command_service("PING"))
        self.create_service(Trigger, "~/request_info", self._command_service("INFO"))
        self.create_service(
            Trigger,
            "~/reset_statistics",
            self._command_service("RESET_STATS", reset=True),
        )
        self.create_timer(0.01, self._drain_serial_events)
        self.create_timer(1.0, self._publish_diagnostics)

        self._transport.start()
        self.get_logger().info(f"OpenTags driver started for {self._port}")

    def _command_service(
        self,
        command: str,
        *,
        reset: bool = False,
    ) -> Callable[[Trigger.Request, Trigger.Response], Trigger.Response]:
        def callback(_request: Trigger.Request, response: Trigger.Response) -> Trigger.Response:
            success, message = self._transport.write_command(command)
            response.success = success
            response.message = message
            if success and reset:
                self._reset_host_statistics()
            return response

        return callback

    def _reset_host_statistics(self) -> None:
        self._range_count = 0
        self._position_count = 0
        self._miss_count = 0
        self._malformed_count = 0
        self._missing_range_sequences = 0
        self._missing_position_sequences = 0
        self._previous_range_sequence = None
        self._previous_position_sequence = None

    def _drain_serial_events(self) -> None:
        for _ in range(200):
            try:
                event = self._transport.events.get_nowait()
            except queue.Empty:
                return

            if isinstance(event, ConnectionState):
                newly_connected = event.connected and not self._connected
                self._connected = event.connected
                self._connection_message = event.message
                if event.connected:
                    self.get_logger().info(event.message)
                    if newly_connected and self._request_info_on_connect:
                        self._transport.write_command("INFO")
                else:
                    self.get_logger().warning(event.message)
                continue

            if isinstance(event, SerialLine):
                self._handle_record(parse_line(event.text))

    def _handle_record(self, record: object) -> None:
        if isinstance(record, RangeRecord):
            self._publish_range(record)
            return
        if isinstance(record, PositionRecord):
            self._publish_position(record)
            return
        if isinstance(record, MissRecord):
            self._miss_count += 1
            self._publish_event(record.raw)
            return
        if isinstance(record, DeviceRecord):
            self._device_fields.update(record.fields)
            self._publish_event(record.raw)
            return
        if isinstance(record, MalformedRecord):
            self._malformed_count += 1
            self.get_logger().warning(
                f"discarding malformed record ({record.reason}): {record.raw}"
            )
            return
        if isinstance(record, TextRecord):
            self._publish_event(record.raw)

    def _publish_range(self, record: RangeRecord) -> None:
        stamp = self.get_clock().now().to_msg()
        self._range_count += 1
        self._missing_range_sequences += sequence_gap(
            self._previous_range_sequence,
            record.sequence,
        )
        self._previous_range_sequence = record.sequence
        self._last_record_time = time.monotonic()
        self._last_range = record

        message = RangeMeasurement()
        message.header.stamp = stamp
        message.header.frame_id = self._frame_id
        message.sequence = record.sequence
        message.distance_m = record.distance_m
        message.has_exchange_time = record.exchange_time_us is not None
        message.exchange_time_us = record.exchange_time_us or 0
        message.has_rssi = record.rssi_dbm is not None
        message.rssi_dbm = record.rssi_dbm or 0.0
        self._range_publisher.publish(message)

        if self._sensor_range_publisher is not None:
            standard = Range()
            standard.header.stamp = stamp
            standard.header.frame_id = self._frame_id
            standard.radiation_type = int(self.get_parameter("sensor_range_radiation_type").value)
            standard.field_of_view = float(self.get_parameter("sensor_range_field_of_view").value)
            standard.min_range = float(self.get_parameter("sensor_range_min_m").value)
            standard.max_range = float(self.get_parameter("sensor_range_max_m").value)
            standard.range = record.distance_m
            self._sensor_range_publisher.publish(standard)

    def _publish_position(self, record: PositionRecord) -> None:
        stamp = self.get_clock().now().to_msg()
        self._position_count += 1
        self._missing_position_sequences += sequence_gap(
            self._previous_position_sequence,
            record.sequence,
        )
        self._previous_position_sequence = record.sequence
        self._last_record_time = time.monotonic()
        self._last_position = record

        point = PointStamped()
        point.header.stamp = stamp
        point.header.frame_id = self._frame_id
        point.point.x = record.x_m
        point.point.y = record.y_m
        point.point.z = record.z_m
        self._position_publisher.publish(point)

        raw = PositionMeasurement()
        raw.header = point.header
        raw.sequence = record.sequence
        raw.position = point.point
        raw.raw_tdoa = list(record.raw_tdoa)
        self._position_raw_publisher.publish(raw)

    def _publish_event(self, text: str) -> None:
        message = String()
        message.data = text
        self._event_publisher.publish(message)

    def _publish_diagnostics(self) -> None:
        now = time.monotonic()
        age = None if self._last_record_time is None else now - self._last_record_time

        if not self._connected:
            level = DiagnosticStatus.ERROR
            summary = self._connection_message
        elif age is None:
            level = DiagnosticStatus.WARN
            summary = "connected; waiting for measurements"
        elif age > self._stale_after_s:
            level = DiagnosticStatus.WARN
            summary = f"measurement stream stale ({age:.1f} s)"
        elif self._malformed_count or self._transport.queue_drops:
            level = DiagnosticStatus.WARN
            summary = "streaming with parser or host queue warnings"
        else:
            level = DiagnosticStatus.OK
            summary = "streaming"

        values = {
            "port": self._port,
            "connected": str(self._connected).lower(),
            "range_records": str(self._range_count),
            "position_records": str(self._position_count),
            "miss_records": str(self._miss_count),
            "malformed_records": str(self._malformed_count),
            "missing_range_sequences": str(self._missing_range_sequences),
            "missing_position_sequences": str(self._missing_position_sequences),
            "host_queue_drops": str(self._transport.queue_drops),
            "last_record_age_s": "never" if age is None else f"{age:.3f}",
        }
        if self._last_range is not None:
            values["last_distance_m"] = f"{self._last_range.distance_m:.3f}"
            values["last_rssi_dbm"] = (
                "unavailable"
                if self._last_range.rssi_dbm is None
                else f"{self._last_range.rssi_dbm:.1f}"
            )
        if self._last_position is not None:
            values["last_position_m"] = (
                f"{self._last_position.x_m:.3f},"
                f"{self._last_position.y_m:.3f},"
                f"{self._last_position.z_m:.3f}"
            )
        for key, value in sorted(self._device_fields.items()):
            values[f"device_{key}"] = value

        status = DiagnosticStatus()
        status.level = level
        status.name = "opentags/serial_driver"
        status.message = summary
        status.hardware_id = self._device_fields.get("id", self._port)
        status.values = [KeyValue(key=key, value=value) for key, value in values.items()]

        array = DiagnosticArray()
        array.header.stamp = self.get_clock().now().to_msg()
        array.status = [status]
        self._diagnostic_publisher.publish(array)

    def destroy_node(self) -> bool:
        self._transport.stop()
        return super().destroy_node()


def main(args: list[str] | None = None) -> None:
    rclpy.init(args=args)
    node = OpenTagsDriver()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
