#!/usr/bin/env python3
"""Re-detect red regions but MERGE adjacent/overlapping blobs within the same logical
muscle into one box (so shoulders = one box with both delts, etc.). Then rebuild the
labeled sheet + regenerate icons with single boxes per muscle."""
import numpy as np
from PIL import Image, ImageDraw

BASE = '/Users/jeffbruzzi/fitness-app'
F = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 01_09_13 PM.png'
ref = np.array(Image.open(F).convert('RGB')).astype(int)
H, W = ref.shape[:2]
r, g, b = ref[:, :, 0], ref[:, :, 1], ref[:, :, 2]
red = (r > 110) * (r > g + 25) * (r > b + 25) * (r < 245)
yy, xx = np.where(red)

# component-label on a dilated red mask so nearby blobs (same muscle) merge
from scipy.ndimage import label as nlabel, find_objects
import scipy.ndimage as nd
# dilate to connect nearby highlight parts of the same muscle (both sides of a paired muscle)
dil = nd.binary_dilation(red, iterations=22)
lab, n = nlabel(dil)
print('merged components (muscles):', n)
boxes = []
for i in range(1, n + 1):
    ys, xs = np.where(lab == i)
    # require a minimum red mass inside the component
    inside = red[ys, xs].sum()
    if inside < 30:
        continue
    x0, x1 = xs.min(), xs.max(); y0, y1 = ys.min(), ys.max()
    boxes.append((int(x0), int(y0), int(x1), int(y1), int(inside)))

# sort reading order
boxes.sort(key=lambda z: (z[1] // 170, z[0]))
print('\nMERGED MUSCLE BOXES (reading order):')
labels = []
for i, (x0, y0, x1, y1, npx) in enumerate(boxes):
    lab = chr(65 + i)
    labels.append(lab)
    cy = ((y0 + y1) / 2) / H
    print(f'  {lab}: x{x0}-{x1} y{y0}-{y1}  yfrac={cy:.2f}  redpx={npx}')

# build labeled sheet (boxes expanded by MARGIN so crop shows more surrounding body)
MARGIN = 38
img = Image.open(F).convert('RGB')
d = ImageDraw.Draw(img)
expanded = []
for lab, (x0, y0, x1, y1, npx) in zip(labels, boxes):
    ex0, ey0, ex1, ey1 = max(0, x0 - MARGIN), max(0, y0 - MARGIN), min(W, x1 + MARGIN), min(H, y1 + MARGIN)
    expanded.append((ex0, ey0, ex1, ey1))
    d.rectangle([ex0, ey0, ex1, ey1], outline=(255, 255, 0), width=3)
    d.text((ex0 + 4, ey0 + 2), lab, fill=(255, 255, 0))
img.save(f'{BASE}/ref2_labeled.png')
print('\nsaved ref2_labeled.png with', len(boxes), 'single boxes (margin', MARGIN, 'px)')

# save box map for later regeneration (expanded)
import json
boxmap = {lab: [ex0, ey0, ex1, ey1] for lab, (ex0, ey0, ex1, ey1) in zip(labels, expanded)}
json.dump(boxmap, open(f'{BASE}/muscle-src/ref2_boxes.json', 'w'), indent=1)
print('saved muscle-src/ref2_boxes.json')
