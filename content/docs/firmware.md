---
title: Firmware
type: docs
prev: /docs/hardware/
next: docs/ios/
---
### Implementing Firmware
Please see the [Hardware](/docs/hardware/) page for information on the devboard that the firmware is being implemented on. This contains the datashets for the Seeed Studio XIAO nRF52840 and the DWM3000 that you will likely reference when implementing the firmware. Currently the SPI pin layouts for the DWM3000 connection are as follows:

```
#define SPI_MOSI 10
#define SPI_MISO 9
#define SPI_SCK 8
#define SPI_CS 0
#define RST 1
#define IRQ 2
```

Since the there is no dedicated Chip-Select, we define `GPIO-0` as the Chip Select for the SPI. We also define `GPIO-2` as the IRQ pin.

### What we have done so far

Since the start of the project, we have had to adapt to limitations by making major changes to both the hardware and the firmware. Following is the list of things we have done in chronological order
1. Earlier, we had an ESP-32-C3-MINI-1 as our primary board with ESP-32 being the primary MCU (pretty obvious, isn't it?). This was our V0 hardware. We implemented BLE functionality and SPI communication with the DWM-3000 chip, and even tested Two-Way Ranging between two boards. However, upon establishing communication with an iOS device, we soon realized that there was much more to the picture.
2. We needed a middlware that could generate `Accessory configuration Data` (Feel free to read more about this in [INCLUDE]). This middleware was found in Qorvo's sample code ([INCLUDE]) and not much to our surprise, it was only developed for MCU's with Arm-Cortex M4 CPU Chipset. So after brainstorming a lot of ideas, we came down to a complete hardware rewire.
3. We now have our V1 hardware with the Seed Studio XIAO nRF52840 boards which meet the middleware's needs. We further implemented BLE functionality and SPI communication with the DWM-3000 chip and actually managed to communicate with the iOS device, coming to point where we needed to start the Double-sided TWR. However, this is where we faced our **latest limitation**. Two-way ranging involves polling (where one party sends the a message, expects the same message back, and based on the time taken, calculates the distance). However this has to fullfil two requirements:
   
      1. The exchange of information should be FiRa compliant
      2. The polling message and response delay are to be decided by both the accessory and iOS device and that information can be only used by another library developed by Qorvo, which has to be incorporated into our existing firmware

We encourage the readers to pick up where we left off. This is also what we plan to work on in the future iterations of this project, considering the limitations we faced and limited time span we had.

### Libraries Used
Currently our firmware relies on a middleware that is developed by Qorvo Inc. This library called `niq` is essential to generate shareable configuration data between the iPhone and the accessory. This  can be obtained after signing a NDA and downloading their sample code which contains this library. We ask you to then drag and drop the `niq` folder into the `lib` folder similar to what we see below

    lib
    | -- Adafruit_nRFCrypto
    | -- Dw3000
    | -- niq

### Programming Devboards
We are using **platform.io** to flash the board with the firmware. The following steps will help you flash the firmware onto the board

1. Download the VS-code extension for platform.io
2. Plug in the devboard to your computer via USB-C.
3. Upload your program via PlatformIO with the upload icon in the top-right corner.

### Debugging Firmware
The devboards  have a serial chip, however, it does not have any debugger attached to it. So there are two ways to debug firmware:
1. Attach an external debugger such as a J-Link
2. Simply print out whatever you want to the serial monitor using `Serial.println()`

There are two Neopixel Led's on the devboard that can be used for visual debugging. They are connected to pin `GPIO3`. 

### Resetting Devboards

If something doesn't work with uploads, you might need to reset by entering ROM Bootloader mode.

1. Plug in the devboard to your computer via USB-c.
2. Flash your code via the steps described above
3. Hold the reset button on the board
4. Open up the Serial Monitor on either the Arduino IDE or VS-Code

This should hard reset the board with the flashed firmware.
