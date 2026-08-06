#!/usr/bin/env python3
"""Build a labeled contact sheet of ref2 with region letters A-M so the user can
assign the correct muscle to each (fixing the image/description mismatch)."""
import numpy as np
from PIL import Image, ImageDraw

BASE = '/Users/jeffbruzzi/fitness-app'
F = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 01_09_13 PM.png'
img = Image.open(F).convert('RGB')
H, W = img.size
# regions in reading order (from detect_positions output)
REGIONS = [
    ('A', 680, 80, 800, 240), ('B', 80, 160, 240, 240), ('C', 1240, 160, 1320, 280),
    ('D', 1360, 160, 1440, 280), ('E', 360, 200, 520, 320), ('F', 920, 200, 1000, 280),
    ('G', 1080, 200, 1120, 280), ('H', 1240, 640, 1320, 720), ('I', 1360, 640, 1440, 720),
    ('J', 120, 680, 200, 840), ('K', 360, 760, 520, 920), ('L', 680, 800, 800, 960),
    ('M', 960, 880, 1080, 1000),
]
# draw a letter badge at top-left of each region on a copy
vis = img.copy()
d = ImageDraw.Draw(vis)
for lab, x0, y0, x1, y1 in REGIONS:
    d.rectangle([x0, y0, x1, y1], outline=(255, 255, 0), width=3)
    d.text((x0 + 4, y0 + 2), lab, fill=(255, 255, 0))
vis.save(f'{BASE}/ref2_labeled.png')
# also a 2-col list text for the user
print('Regions (reading order, top row then bottom row):')
for lab, x0, y0, x1, y1 in REGIONS:
    print(f'  {lab}: cell position (col,row) ~ x{x0}-{x1} y{y0}-{y1}')
print('saved ref2_labeled.png')
