#!/usr/bin/env python3
"""List serial ports that can be passed to the other opentags scripts."""

from opentag_serial import available_ports

ports = available_ports()
if not ports:
    print("No serial ports found.")
for port in ports:
    print(f"{port['device']}\t{port['description']}\t{port['hwid']}")
