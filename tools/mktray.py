#!/usr/bin/env python3
"""Generates resources/tray.png: a 32x32 template-style monochrome icon
(black pixels with alpha) showing radio broadcast waves over a dot."""
import struct, zlib

W = H = 32
px = [[(0, 0, 0, 0)] * W for _ in range(H)]

def put(x, y, a):
    if 0 <= x < W and 0 <= y < H:
        r, g, b, old = px[y][x]
        px[y][x] = (0, 0, 0, max(old, a))

# antenna dot at bottom center
cx, cy = 16, 24
for y in range(H):
    for x in range(W):
        d2 = (x - cx) ** 2 + (y - cy) ** 2
        if d2 <= 9:
            put(x, y, 255)
        elif d2 <= 16:
            put(x, y, 120)

# three arcs of broadcast waves
def arc(radius, thickness=2):
    for t in range(3600):
        import math
        ang = math.radians(t / 10 + 90)  # upper half
        r = radius
        x = round(cx + r * math.cos(ang))
        y = round(cy - r * math.sin(ang))
        if y <= cy:
            a = 255 if abs(r - radius) < 0.6 else 180
            for tt in range(thickness):
                put(x, y - tt, a)

for radius, a in ((6, 200), (10, 230), (14, 255)):
    for t in range(0, 1800):
        import math
        ang = math.radians(t / 10)
        x = round(cx + radius * math.cos(ang + math.pi / 2))
        y = round(cy - radius * math.sin(ang + math.pi / 2))
        if y < cy - 2:
            put(x, y, a)

raw = b""
for row in px:
    raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))
open("resources/tray.png", "wb").write(png)
print("wrote resources/tray.png", len(png), "bytes")
