"""ROS-level loopback test, executed by colcon in a sourced ROS environment."""

from __future__ import annotations

import math
import time
from collections.abc import Callable

import rclpy
from opentags_driver.driver import OpenTagsDriver
from opentags_msgs.msg import RangeMeasurement
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.parameter import Parameter
from rclpy.qos import qos_profile_sensor_data


def test_driver_publishes_looped_range_record() -> None:
    rclpy.init()
    driver = OpenTagsDriver(
        parameter_overrides=[
            Parameter("port", value="loop://"),
            Parameter("request_info_on_connect", value=False),
        ]
    )
    observer = Node("opentags_driver_test_observer")
    received: list[RangeMeasurement] = []
    subscription = observer.create_subscription(
        RangeMeasurement,
        "opentags/range",
        received.append,
        qos_profile_sensor_data,
    )

    executor = SingleThreadedExecutor()
    executor.add_node(driver)
    executor.add_node(observer)
    try:
        _spin_until(executor, lambda: driver._transport.connected)
        success, message = driver._transport.write_command("D 42 3046 16174 -748")
        assert success, message
        _spin_until(executor, lambda: bool(received))

        measurement = received[0]
        assert measurement.sequence == 42
        assert math.isclose(measurement.distance_m, 3.046)
        assert measurement.has_exchange_time
        assert measurement.exchange_time_us == 16174
        assert measurement.has_rssi
        assert math.isclose(measurement.rssi_dbm, -74.8, abs_tol=1e-4)
    finally:
        observer.destroy_subscription(subscription)
        executor.remove_node(observer)
        executor.remove_node(driver)
        observer.destroy_node()
        driver.destroy_node()
        executor.shutdown()
        rclpy.shutdown()


def _spin_until(
    executor: SingleThreadedExecutor,
    condition: Callable[[], bool],
    timeout_s: float = 3.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        executor.spin_once(timeout_sec=0.05)
        if condition():
            return
    raise AssertionError("condition was not reached before timeout")
