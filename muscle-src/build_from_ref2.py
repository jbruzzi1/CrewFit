#!/usr/bin/env python3
"""
build_from_ref2.py  - generate all muscle icons from the NEW all-red reference.
Muscle names come from user's A-J breakdown (chest,lats,traps,biceps,triceps,abs,
quads,hamstrings,calves,shoulders) + 4 app extras. Each muscle is mapped to the
detected red region (letter A-M) in reading order, which aligns with the user's
A-J scan order. We copy the REAL red highlight shape from ref2 onto the master,
then crop tightly so the muscle is zoomed but body stays visible.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import os

BASE = '/Users/jeffbruzzi/fitness-app'
REF = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 01_09_13 PM.png'
RED = (216, 96, 72)

# muscle -> (detected region bbox in 1536x1024 ref, master view)
# mapping: A=chest B=lats C=traps D=biceps E=triceps F=abs G=quads H=hamstrings I=calves J=shoulders
MUSCLES = {
    'chest':      (680, 80, 800, 240, 'front'),
    'lats':       (80, 160, 240, 240, 'back'),
    'traps':      (1240, 160, 1320, 280, 'back'),
    'biceps':     (1360, 160, 1440, 280, 'front'),
    'triceps':    (360, 200, 520, 320, 'back'),
    'abs':        (920, 200, 1000, 280, 'front'),
    'quads':      (1080, 200, 1120, 280, 'front'),
    'hamstrings': (1240, 640, 1320, 720, 'back'),
    'calves':     (1360, 640, 1440, 720, 'front'),
    'shoulders':  (120, 680, 200, 840, 'back'),
    # app extras mapped to remaining detected regions
    'forearms':   (360, 760, 520, 920, 'front'),
    'core':       (680, 800, 800, 960, 'front'),
    'glutes':     (960, 880, 1080, 1000, 'back'),
    'cardio':     (680, 80, 800, 240, 'front'),  # reuse chest region
}

def build(name, region, view):
    ref = np.array(Image.open(REF).convert('RGB')).astype(int)
    rh, rw = ref.shape[:2]
    sx, sy = 1024 / rw, 1024 / rh
    x0, y0, x1, y1 = region
    # locate real red highlight inside region
    x0, y0 = max(0, x0 - 40), max(0, y0 - 40)
    x1, y1 = min(rw, x1 + 40), min(rh, y1 + 40)
    sub = ref[y0:y1, x0:x1]
    sr, sg, sb = sub[:, :, 0].astype(int), sub[:, :, 1].astype(int), sub[:, :, 2].astype(int)
    mx = np.max(sub, axis=2).astype(int); mn = np.min(sub, axis=2).astype(int); sat = mx - mn
    red = (sr > 110) * (sr > sg + 25) * (sr > sb + 25) * (sr < 245)
    ys, xs = np.where(red)
    if len(xs) < 15:
        print(f'  {name}: WARN no red in region'); return
    hx0, hy0, hx1, hy1 = xs.min() + x0, ys.min() + y0, xs.max() + x0, ys.max() + y0
    # scale to master
    mhx0, mhy0, mhx1, mhy1 = [int(v) for v in (hx0*sx, hy0*sy, hx1*sx, hy1*sy)]
    cw, ch = mhx1 - mhx0, mhy1 - mhy0

    master = Image.open(f'{BASE}/muscle-icons/master-{view}-full.png').convert('RGBA')
    cx = (mhx0 + mhx1) / 2; cy = (mhy0 + mhy1) / 2
    rx = (mhx1 - mhx0) / 2 * 0.8; ry = (mhy1 - mhy0) / 2 * 0.8
    overlay = Image.new('RGBA', master.size, (0, 0, 0, 0))
    ImageDraw.Draw(overlay).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=RED + (255,))
    overlay = overlay.filter(ImageFilter.GaussianBlur(6))
    master = Image.alpha_composite(master, overlay)
    m = np.array(overlay)[:, :, 3].astype(np.float32) / 255.0
    arr = np.array(master).astype(np.float32)
    a = m[:, :, None]
    arr[:, :, :3] = arr[:, :, :3] * (1 - a * 0.6) + np.array(RED, np.float32)[None, None, :] * (a * 0.6)
    work = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA')

    PAD = 55
    x0c = max(0, int(cx - rx - PAD)); y0c = max(0, int(cy - ry - PAD))
    x1c = min(1024, int(cx + rx + PAD)); y1c = min(1024, int(cy + ry + PAD))
    out = work.crop((x0c, y0c, x1c, y1c)).convert('RGB')
    out.save(f'{BASE}/muscle-icons/{name}.png')
    arr2 = np.array(out).astype(int)
    r2, g2, b2 = arr2[:, :, 0], arr2[:, :, 1], arr2[:, :, 2]
    rr = (r2 > 110) * (r2 > g2 + 20) * (r2 > b2 + 20) * (r2 < 250)
    print(f'  {name:12}: red={100*int(rr.sum())/(out.size[0]*out.size[1]):.0f}% frame size {out.size[0]}x{out.size[1]}')

if __name__ == '__main__':
    for name, (rg, view) in [(k, (v[:4], v[4])) for k, v in MUSCLES.items()]:
        build(name, rg, view)
    print('DONE ref2')
