#!/usr/bin/env python3
"""Draw the NetRoute icon (route of hops on a blue tile) as PNGs, stdlib only."""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "icons")
BG = (37, 99, 235)        # blue tile
LINE = (255, 255, 255)
NODE = (255, 255, 255)
END = (251, 146, 60)      # orange destination
PATH = [(30, 92), (54, 42), (78, 80), (100, 34)]   # in a 128x128 design space
LINE_W, NODE_R, END_R, RADIUS = 9, 10, 13, 28


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def sample(x, y):
    """Colour of the design at (x, y) in 128-space, or None for transparent."""
    # rounded-square tile
    cx, cy = min(max(x, RADIUS), 128 - RADIUS), min(max(y, RADIUS), 128 - RADIUS)
    if not (0 <= x <= 128 and 0 <= y <= 128) or math.hypot(x - cx, y - cy) > RADIUS:
        return None
    for i, (nx, ny) in enumerate(PATH):
        r = END_R if i == len(PATH) - 1 else NODE_R
        if math.hypot(x - nx, y - ny) <= r:
            return END if i == len(PATH) - 1 else NODE
    for (ax, ay), (bx, by) in zip(PATH, PATH[1:]):
        if seg_dist(x, y, ax, ay, bx, by) <= LINE_W / 2:
            return LINE
    return BG


def render(size, ss=4):
    scale = 128 / (size * ss)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = sample((x * ss + sx + .5) * scale, (y * ss + sy + .5) * scale)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            row += bytes([r // a, g // a, b // a, 255 * a // n]) if a else b"\0\0\0\0"
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        with open(os.path.join(OUT, f"icon{size}.png"), "wb") as f:
            f.write(render(size))
        print(f"icons/icon{size}.png")
