#!/usr/bin/env python3
"""توليد أيقونات الإضافة (PNG) بمكتبة بايثون القياسية فقط.

الفكرة البصرية: ثلاثة صفوف من "بطاقات بيانات"، الصف الأعلى مُميَّز بلون
التمييز لأنه المُلتقط، والباقي بلون هادئ — إشارة إلى "التقاط عنصر ثم تكراره" .

    python tools/make_icons.py
"""
from __future__ import annotations

import os
import struct
import sys
import zlib

BG_TOP = (11, 18, 32)
BG_BOTTOM = (18, 30, 52)
CARD_LIGHT = (52, 211, 153)
CARD_LIGHT_DIM = (24, 128, 96)
CARD_MUTED = (100, 116, 139)

SS = 4  # معامل التكبير ثم التصغير للحصول على حواف ناعمة


def rounded_rect_coverage(x, y, rx0, ry0, rx1, ry1, radius):
    """يعيد 1 داخل المستطيل ذي الحواف الدائرية، 0 خارجه (تُحسب في نقاط مكبّرة)."""
    if x < rx0 or x > rx1 or y < ry0 or y > ry1:
        return 0
    for cx, cy in ((rx0 + radius, ry0 + radius), (rx1 - radius, ry0 + radius),
                   (rx0 + radius, ry1 - radius), (rx1 - radius, ry1 - radius)):
        inside_x = (x < rx0 + radius) if cx == rx0 + radius else (x > rx1 - radius)
        inside_y = (y < ry0 + radius) if cy == ry0 + radius else (y > ry1 - radius)
        if inside_x and inside_y:
            dx, dy = x - cx, y - cy
            return 1 if dx * dx + dy * dy <= radius * radius else 0
    return 1


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def render(size):
    w = h = size * SS
    px = [[(0, 0, 0) for _ in range(w)] for _ in range(h)]
    radius = w * 0.22

    # خلفية متدرّجة داخل مربع بحواف دائرية
    for y in range(h):
        base = mix(BG_TOP, BG_BOTTOM, y / max(1, h - 1))
        for x in range(w):
            px[y][x] = base if rounded_rect_coverage(x + 0.5, y + 0.5, 0, 0, w, h, radius) else (0, 0, 0)

    # ثلاثة "صفوف بيانات": كل صف مستطيل أفقي + مربع صغير على اليمين (صورة مصغّرة)
    pad = w * 0.17
    gap = h * 0.115
    row_h = (h - pad * 2 - gap * 2) / 3
    row_r = row_h * 0.22
    thumb = row_h * 0.62

    palette = [CARD_LIGHT, CARD_MUTED, CARD_MUTED]
    for i in range(3):
        y0 = pad + i * (row_h + gap)
        y1 = y0 + row_h
        x1 = w - pad
        x0 = pad
        # جسم الصف
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                if not rounded_rect_coverage(x + 0.5, y + 0.5, x0, y0, x1, y1, row_r):
                    continue
                if i == 0:
                    color = mix(CARD_LIGHT, CARD_LIGHT_DIM, (y - y0) / max(1.0, row_h))
                else:
                    color = palette[i]
                # مزج بسيط مع الخلفية بحسب تغطية الزوايا
                px[y][x] = mix(px[y][x], color, 0.92)
        # مربّع الصورة المصغّرة
        tx1 = x1 - row_h * 0.18
        tx0 = tx1 - thumb
        ty0 = y0 + (row_h - thumb) / 2
        ty1 = ty0 + thumb
        for y in range(int(ty0), int(ty1) + 1):
            for x in range(int(tx0), int(tx1) + 1):
                if not rounded_rect_coverage(x + 0.5, y + 0.5, tx0, ty0, tx1, ty1, thumb * 0.28):
                    continue
                color = CARD_LIGHT if i == 0 else (148, 163, 184)
                px[y][x] = mix(px[y][x], color, 0.85)

    # تصغير بمعدّل بسيط
    out = bytearray()
    for y in range(size):
        out.append(0)  # نوع مرشّح PNG للسطر
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                for dx in range(SS):
                    c = px[y * SS + dy][x * SS + dx]
                    r += c[0]
                    g += c[1]
                    b += c[2]
            n = SS * SS
            out += bytes((r // n, g // n, b // n))
    return bytes(out)


def write_png(path, size):
    raw = render(size)
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) +
           chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as handle:
        handle.write(png)
    print('كُتب ' + path + ' (' + str(len(png)) + ' بايت)')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'icons')
    os.makedirs(target, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(target, 'icon%d.png' % size), size)


if __name__ == '__main__':
    main()
