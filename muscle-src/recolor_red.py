#!/usr/bin/env python3
"""Recolor: replace the green muscle-highlight with the user's red (chest red ~216,96,72)
across all muscle icons. Works on whatever highlight currently exists (green),
so it's uniform regardless of how each icon was generated."""
import numpy as np
from PIL import Image
import os

BASE = '/Users/jeffbruzzi/fitness-app/muscle-icons'
# chest red measured from reference: dominant (216,96,72); use a clean version
RED = np.array([216, 96, 72], np.float32)
# detect the green we used: #16a34a = (22,163,74)
GREEN = np.array([22, 163, 74], np.float32)

icons = [f for f in os.listdir(BASE) if f.endswith('.png') and not f.startswith('master')
         and f not in ('paint.html',)]

for name in ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'abs',
             'core', 'quads', 'hamstrings', 'calves', 'glutes', 'traps', 'cardio']:
    p = os.path.join(BASE, f'{name}.png')
    if not os.path.exists(p):
        print(f'  skip {name} (no file)')
        continue
    im = np.array(Image.open(p).convert('RGBA')).astype(np.float32)
    r, g, b = im[:, :, 0].astype(int), im[:, :, 1].astype(int), im[:, :, 2].astype(int)
    # green highlight mask: green dominant, not white/black
    mask = (g > 110) & (g < 200) & (r < 110) & (b < 140) & (g - r > 40) & (g - b > 20)
    m = mask.astype(np.float32)[:, :, None]
    # blend: where green, mix toward RED at same intensity (0.85)
    im[:, :, :3] = im[:, :, :3] * (1 - m * 0.85) + RED[None, None, :] * (m * 0.85)
    out = Image.fromarray(np.clip(im, 0, 255).astype(np.uint8), 'RGBA').convert('RGB')
    out.save(p)
    n = int(mask.sum())
    print(f'  {name}: recolored {n} green px -> red' + (f' (cropped lower)' if name in ('quads', 'hamstrings', 'calves', 'glutes') else ''))
print('DONE - all icons now use red highlight')
