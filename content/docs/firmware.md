---
title: Firmware
type: docs
prev: /docs/hardware/
next: docs/ios/
---
### Implementing Firmware
Please see the [Hardware](/docs/hardware/) page for information on the devboard that the firmware is being implemented on. This contains the datashets for the ESP32-C3-MINI-1 and the DWM3000 that you will likely reference when implementing the firmware.

### Debugging Firmware
The devboards do not have a serial chip, so you will need to use the `USBSerial` library to print debug messages to the terminal. 

There are two Neopixel Led's on the devboard that can be used for visual debugging. They are connected to pin `GPIO3`. 

### Programming Devboards

1. Plug in the devboard to your computer via USB-c.
2. Upload your program via PlatformIO with the upload icon in the bottom left corner.

### Resetting Devboards

If something doesn't work with uploads, you might need to reset by entering ROM Bootloader mode.

1. Plug in the devboard to your computer via USB-c.
2. Hold down the `BOOT` button on the devboard. Then press the `RESET` button. Then let go of both at the same time. 
3. Then in the terminal, run the following: 

    ```esptool.py --port /dev/cu.usbmodemxx chip_id```

    Where `/dev/cu.usbmodemxx` is the port that the devboard is connected to.

    [This tutorial](https://learn.adafruit.com/adafruit-magtag/rom-bootloader) is where the above steps were taken from. Thanks Lady Ada!

