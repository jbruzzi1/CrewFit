#!/usr/bin/env python3
"""Inspect ref2: for each of the 14 muscles, crop the EXACT region from the reference image
(keeping the real mannequin + real highlight), scale to a consistent icon size, and save.
No synthetic ellipse — we copy what's in your image, just cropped/zoomed."""
import numpy as np
from PIL import Image
import os

BASE = '/Users/jeffbruzzi/fitness-app'
REF = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 01_09_13 PM.png'
ref = np.array(Image.open(REF).convert('RGB')).astype(int)
H, W = ref.shape[:2]
print('ref size', W, H)

# Detect all red highlight regions (reading order) so we know where each muscle sits
r, g, b = ref[:, :, 0], ref[:, :, 1], ref[:, :, 2]
red = (r > 110) * (r > g + 25) * (r > b + 25) * (r < 245)
yy, xx = np.where(red)
print('total red px', len(xx), 'x', xx.min(), xx.max(), 'y', yy.min(), yy.max())

# grid: 6 cols x 2 rows -> 12 cells. map muscle name to cell (col,row)
# user A-J: chest,lats,traps,biceps,triceps,abs,quads,hamstrings,calves,shoulders
# detected cells (reading order) from prior scan:
#  A x680-800 y80-240 chest      B x80-240 y160-240 lats
#  C x1240-1320 y160-280 traps   D x1360-1440 y160-280 biceps
#  E x360-520 y200-320 triceps   F x920-1000 y200-280 abs
#  G x1080-1120 y200-280 quads   H x1240-1320 y640-720 hamstrings
#  I x1360-1440 y640-720 calves  J x120-200 y680-840 shoulders
#  K x360-520 y760-920 forearms  L x680-800 y800-960 core
#  M x960-1080 y880-1000 glutes  (cardio reuses chest)
CELLS = {
    'chest':      (680, 80, 800, 240),
    'lats':       (80, 160, 240, 240),
    'traps':      (1240, 160, 1320, 280),
    'biceps':     (1360, 160, 1440, 280),
    'triceps':    (360, 200, 520, 320),
    'abs':        (920, 200, 1000, 280),
    'quads':      (1080, 200, 1120, 280),
    'hamstrings': (1240, 640, 1320, 720),
    'calves':     (1360, 640, 1440, 720),
    'shoulders':  (120, 680, 200, 840),
    'forearms':   (360, 760, 520, 920),
    'core':       (680, 800, 800, 960),
    'glutes':     (960, 880, 1080, 1000),
    'cardio':     (680, 80, 800, 240),
}

# For each muscle, find the REAL red bbox inside its cell, then crop the cell tightly
# around the muscle so the mannequin + highlight shows, zoomed.
ICON = 200  # output icon size
for name, (x0, y0, x1, y1) in CELLS.items():
    sub = ref[y0:y1, x0:x1]
    sr, sg, sb = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    rmask = (sr > 110) * (sr > sg + 25) * (sr > sb + 25) * (sr < 245)
    ys, xs = np.where(rmask)
    if len(xs) < 10:
        print(f'  {name}: no red in cell, skip'); continue
    # crop the cell around the highlight with padding, keep aspect
    pad = 40
    cx0 = max(x0, xs.min() + x0 - pad); cy0 = max(y0, ys.min() + y0 - pad)
    cx1 = min(x1, xs.max() + x0 + pad); cy1 = min(y1, ys.max() + y0 + pad)
    crop = Image.open(REF).convert('RGB').crop((cx0, cy0, cx1, cy1))
    # letterbox to ICON x ICON
    cw, ch = crop.size
    scale = ICON / max(cw, ch)
    nw, nh = int(cw * scale), int(ch * scale)
    crop = crop.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGB', (ICON, ICON), (247, 248, 250))
    canvas.paste(crop, ((ICON - nw) // 2, (ICON - nh) // 2))
    canvas.save(f'{BASE}/muscle-icons/{name}.png')
    print(f'  {name}: crop {crop.size} -> icon {ICON}x{ICON}  red={100*int(rmask.sum())/(sub.shape[0]*sub.shape[1]):.0f}% cell')
print('DONE - icons copied from reference (real mannequin + real highlight)')
