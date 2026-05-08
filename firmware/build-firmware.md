# Rebuilding firmware bins

The firmware console fetches prebuilt `.bin` files from `firmware/bins/`.

From the umbrella repo root:

```sh
cd firmware/rust_bringup/stm32g4
cargo objcopy --release --bin twr_node -- -O binary ../../../open-tags.github.io/firmware/bins/twr_node.bin
```

One-time setup:

```sh
rustup component add llvm-tools-preview
cargo install cargo-binutils
```

The STM32 ROM bootloader expects a flat binary image starting at
`0x08000000`, so the browser flasher uses `.bin` files rather than `.elf`
artifacts.
