#!/usr/bin/env python3
"""Regenerate specific box icons with EXTRA padding so more of the mannequin + muscle shows.
Targets: A, C, I, J (user: too tight). Extra pad = 70px (vs default 30)."""
import numpy as np
from PIL import Image
import os, json

BASE = '/Users/jeffbruzzi/fitness-app'
REF = f'{BASE}/.hermes/desktop-attachments/ChatGPT Image Aug 6, 2026, 01_09_13 PM.png'
boxmap = json.load(open(f'{BASE}/muscle-src/ref2_boxes.json'))
ICON = 200
EXTRA = {'A': 70, 'C': 70, 'I': 70, 'J': 70}

for lab, (x0, y0, x1, y1) in boxmap.items():
    pad = EXTRA.get(lab, 30)
    cx0 = max(0, x0 - pad); cy0 = max(0, y0 - pad)
    cx1 = min(1536, x1 + pad); cy1 = min(1024, y1 + pad)
    crop = Image.open(REF).convert('RGB').crop((cx0, cy0, cx1, cy1))
    cw, ch = crop.size
    scale = ICON / max(cw, ch)
    nw, nh = int(cw * scale), int(ch * scale)
    crop = crop.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGB', (ICON, ICON), (247, 248, 250))
    canvas.paste(crop, ((ICON - nw) // 2, (ICON - nh) // 2))
    canvas.save(f'{BASE}/muscle-icons/box_{lab}.png')
    print(f'  box_{lab}: pad={pad} crop {cw}x{ch} -> icon {ICON}x{ICON}')
print('DONE - A/C/I/J regenerated with extra 70px padding')
