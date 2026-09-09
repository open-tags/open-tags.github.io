#!/usr/bin/env python3
"""Set a persistent node ID in a CAN-enabled responder image before flashing."""

import argparse
import struct
from pathlib import Path

MAGIC = b"OTAG-CAN-NODE\0\0\0"


def patch_image(image, node):
    if not 1 <= node <= 63:
        raise ValueError("CAN node ID must be between 1 and 63")
    if image.count(MAGIC) != 1:
        raise ValueError("expected exactly one CAN node block; use the CAN-enabled responder image")
    offset = image.index(MAGIC) + len(MAGIC)
    if offset + 4 > len(image):
        raise ValueError("truncated CAN node block")
    old_node = struct.unpack_from("<I", image, offset)[0]
    if not 1 <= old_node <= 63:
        raise ValueError("existing node block is invalid; use a fresh firmware download")
    result = bytearray(image)
    struct.pack_into("<I", result, offset, node)
    return bytes(result)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("firmware", type=Path)
    parser.add_argument("--node", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new output file; never overwrites a file")
    args = parser.parse_args(argv)
    try:
        result = patch_image(args.firmware.read_bytes(), args.node)
        with args.output.open("xb") as output:
            output.write(result)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Saved node {args.node} firmware to {args.output}. Flash this image to the responder.")


if __name__ == "__main__":
    main()
