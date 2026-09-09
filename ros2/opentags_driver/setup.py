from glob import glob

from setuptools import find_packages, setup

package_name = "opentags_driver"


setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.py")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
    ],
    install_requires=["setuptools", "pyserial>=3.5"],
    zip_safe=True,
    maintainer="OpenTags",
    maintainer_email="hello@open-tags.com",
    description="Reconnect-capable ROS 2 USB serial driver for OpenTag UWB devices.",
    license="Apache-2.0",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "opentags_driver = opentags_driver.driver:main",
        ],
    },
)
