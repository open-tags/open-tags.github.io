---
title: Documentation
next: docs/firmware/
---

We split the documentation into several sections:

- [Firmware](/docs/firmware/)
- [Hardware](/docs/hardware/)
- [iOS](/docs/ios/)

A super high-level overview of Opentags is as follows:

We have a [ESP32-C3-MINI-1](https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf) talks via SPI to [DWM3000](https://www.qorvo.com/products/p/DWM3000). The DWM3000 is a module that can be used for ranging and positioning via [UWB](https://en.wikipedia.org/wiki/Ultra-wideband) (Ultra Wide Band).

The Opentag is compatible with other Opentag and UWB devices, including but not limited to the Apple [U1 and U2](https://en.wikipedia.org/wiki/Apple_silicon#Apple_U1) chip inside of the iPhone 11 and newer.

The Opentag is designed to be a simple, easy to use, and low-cost UWB device. It is designed to be used in a variety of applications, including but not limited to:

- Asset tracking
- Indoor positioning
- Outdoor positioning
- Robotics
