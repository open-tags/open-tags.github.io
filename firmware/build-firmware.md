# Rebuilding firmware bins

The firmware console fetches prebuilt `.bin` files from `firmware/bins/`.

From the umbrella repo root:

```sh
cd firmware/rust_bringup/stm32g4
cargo objcopy --release --bin twr_init -- -O binary ../../../open-tags.github.io/firmware/bins/twr_init.bin
cargo objcopy --release --bin twr_resp -- -O binary ../../../open-tags.github.io/firmware/bins/twr_resp.bin
```

The release profile uses size optimization and fat LTO because the role images
run from the STM32G474CC's 128 KiB bank-one linker region.

One-time setup:

```sh
rustup component add llvm-tools-preview
cargo install cargo-binutils
```

The STM32 ROM bootloader expects a flat binary image starting at
`0x08000000`, so the browser flasher uses `.bin` files rather than `.elf`
artifacts.
