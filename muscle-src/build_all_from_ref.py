#!/usr/bin/env python3
"""
build_all_from_ref.py  (v3 - simple, robust)

For each muscle:
  - locate the real highlight bbox in your ChatGPT reference (accurate muscle position)
  - scale that bbox to the 1024 master (front/back)
  - draw a RED filled ellipse sized to the muscle (0.82 of bbox), soft edge
  - crop around it with modest padding so the body stays visible
Result: a zoomed icon with a clear muscle-shaped red highlight + visible body.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import os

BASE = '/Users/jeffbruzzi/fitness-app'
REF = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 12_06_33 PM.png'
RED = (216, 96, 72)

MUSCLES = {
    'chest':      (48, 144, 240, 240, 'front'),
    'lats':       (384, 192, 528, 336, 'back'),
    'traps':      (672, 96, 816, 240, 'back'),
    'biceps':     (96, 672, 192, 864, 'front'),
    'triceps':    (384, 768, 528, 960, 'back'),
    'abs':        (672, 816, 816, 960, 'front'),
    'quads':      (912, 192, 1152, 288, 'front'),
    'hamstrings': (1248, 624, 1440, 720, 'back'),
    'calves':     (960, 912, 1104, 1008, 'front'),
    'shoulders':  (1200, 192, 1440, 288, 'back'),
    'forearms':   (96, 864, 300, 1008, 'front'),
    'core':       (672, 864, 816, 1008, 'front'),
    'glutes':     (1248, 600, 1440, 760, 'back'),
    'cardio':     (48, 144, 240, 240, 'front'),
}

def find_highlight_bbox(ref, region):
    x0, y0, x1, y1 = region
    x0, y0 = max(0, x0 - 60), max(0, y0 - 60)
    x1, y1 = min(ref.shape[1], x1 + 60), min(ref.shape[0], y1 + 60)
    sub = ref[y0:y1, x0:x1]
    sr = sub[:, :, 0].astype(int); sg = sub[:, :, 1].astype(int); sb = sub[:, :, 2].astype(int)
    mx = np.max(sub, axis=2).astype(int); mn = np.min(sub, axis=2).astype(int); sat = mx - mn
    hue = (sat > 35) * ~((np.abs(sr - sg) < 18) * (np.abs(sg - sb) < 18) * (np.abs(sr - sb) < 18))
    ys, xs = np.where(hue)
    if len(xs) < 20:
        return None
    return (xs.min() + x0, ys.min() + y0, xs.max() + x0, ys.max() + y0)

# manual fallback body positions (1024 master space) when ref detection is too weak
FALLBACK = {
    'forearms': (430, 860, 600, 980),  # front: lower arms beside thighs
}

def build(name, region, view):
    ref = np.array(Image.open(REF).convert('RGB')).astype(int)
    rh, rw = ref.shape[:2]
    sx, sy = 1024 / rw, 1024 / rh
    hb = find_highlight_bbox(ref, region)
    if hb is None or (hb[2] - hb[0]) * sx < 30:
        if name in FALLBACK:
            hb = FALLBACK[name]
            hb = (int(hb[0] * sx), int(hb[1] * sy), int(hb[2] * sx), int(hb[3] * sy))
        else:
            print(f'  {name}: WARN no highlight'); return
    else:
        hb = [int(v) for v in (hb[0]*sx, hb[1]*sy, hb[2]*sx, hb[3]*sy)]
    hx0, hy0, hx1, hy1 = hb
    cw, ch = hx1 - hx0, hy1 - hy0

    master = Image.open(f'{BASE}/muscle-icons/master-{view}-full.png').convert('RGBA')
    # draw red ellipse at the muscle location
    cx = (hx0 + hx1) / 2; cy = (hy0 + hy1) / 2
    rx = (hx1 - hx0) / 2 * 0.82; ry = (hy1 - hy0) / 2 * 0.82
    overlay = Image.new('RGBA', master.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=RED + (255,))
    overlay = overlay.filter(ImageFilter.GaussianBlur(6))
    master = Image.alpha_composite(master, overlay)
    # tint the red region more solidly (alpha_composite keeps it soft)
    m = np.array(overlay)[:, :, 3].astype(np.float32) / 255.0
    arr = np.array(master).astype(np.float32)
    a = m[:, :, None]
    arr[:, :, :3] = arr[:, :, :3] * (1 - a * 0.6) + np.array(RED, np.float32)[None, None, :] * (a * 0.6)
    work = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA')

    # crop with modest padding so body stays visible
    PAD = 55
    x0c = max(0, int(cx - rx - PAD)); y0c = max(0, int(cy - ry - PAD))
    x1c = min(1024, int(cx + rx + PAD)); y1c = min(1024, int(cy + ry + PAD))
    out = work.crop((x0c, y0c, x1c, y1c)).convert('RGB')
    out.save(f'{BASE}/muscle-icons/{name}.png')
    arr2 = np.array(out).astype(int)
    r2, g2, b2 = arr2[:, :, 0], arr2[:, :, 1], arr2[:, :, 2]
    red = (r2 > 110) * (r2 > g2 + 20) * (r2 > b2 + 20) * (r2 < 250)
    print(f'  {name}: red={100*int(red.sum())/(out.size[0]*out.size[1]):.0f}% frame, size {out.size[0]}x{out.size[1]}')

if __name__ == '__main__':
    for name, (rg, view) in [(k, (v[:4], v[4])) for k, v in MUSCLES.items()]:
        build(name, rg, view)
    print('DONE v3')
