"""Launch one OpenTags USB serial driver."""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description() -> LaunchDescription:
    return LaunchDescription(
        [
            DeclareLaunchArgument(
                "port",
                default_value="/dev/ttyACM0",
                description="OpenTag USB CDC serial port or pyserial URL",
            ),
            DeclareLaunchArgument("frame_id", default_value="opentag"),
            DeclareLaunchArgument("publish_sensor_range", default_value="false"),
            Node(
                package="opentags_driver",
                executable="opentags_driver",
                name="opentags_driver",
                output="screen",
                parameters=[
                    {
                        "port": LaunchConfiguration("port"),
                        "frame_id": LaunchConfiguration("frame_id"),
                        "publish_sensor_range": ParameterValue(
                            LaunchConfiguration("publish_sensor_range"),
                            value_type=bool,
                        ),
                    }
                ],
            ),
        ]
    )
