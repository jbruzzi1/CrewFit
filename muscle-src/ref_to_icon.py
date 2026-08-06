#!/usr/bin/env python3
"""
ref_to_icon.py - Build a muscle icon from a ChatGPT/FAL reference image.

Pipeline:
  1. Load reference PNG (any size; e.g. 1536x1024 or 1024x1024).
  2. Detect the green-tinted highlight region (the muscle).
  3. Scale the detected region to the master's 1024 space.
  4. Paint that region green (#16a34a) onto the clean master (front or back).
  5. Save the icon. If it's a leg muscle, crop to the lower body.

Usage:
  python3 ref_to_icon.py --ref <img.png> --name chest --view front [--leg]
"""
import argparse, json, os
from PIL import Image, ImageFilter
import numpy as np

BASE = '/Users/jeffbruzzi/fitness-app'
GREEN = np.array([22, 163, 74], np.float32)

def detect_green(im_np):
    r, g, b = im_np[:, :, 0].astype(int), im_np[:, :, 1].astype(int), im_np[:, :, 2].astype(int)
    mask = (g > r + 6) & (g > b + 6) & (g > 90) & (g < 235) & ~((r > 225) & (g > 225) & (b > 225))
    return mask

def region_bbox(mask, scale_x, scale_y):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    x0, x1 = int(xs.min() * scale_x), int(xs.max() * scale_x)
    y0, y1 = int(ys.min() * scale_y), int(ys.max() * scale_y)
    return (x0, y0, x1, y1)

def build_icon(ref_path, name, view, is_leg=False):
    ref = np.array(Image.open(ref_path).convert('RGB')).astype(int)
    rh, rw = ref.shape[:2]
    master_path = f'{BASE}/muscle-icons/master-{"front" if view=="front" else "back"}-full.png'
    master = np.array(Image.open(master_path).convert('RGBA')).astype(np.float32)
    mh, mw = master.shape[:2]
    sx, sy = mw / rw, mh / rh

    mask = detect_green(ref)
    bbox = region_bbox(mask, sx, sy)
    if not bbox:
        print(f'  [{name}] NO green region found in reference - skipping')
        return None
    x0, y0, x1, y1 = bbox
    print(f'  [{name}] detected green region (1024-space): x{x0}-{x1} y{y0}-{y1}')

    # Build a soft green mask from the bbox, with gaussian feather
    H, W = mh, mw
    yy, xx = np.mgrid[0:H, 0:W]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = max(1, (x1 - x0) / 2), max(1, (y1 - y0) / 2)
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    m = (1.0 - np.clip((d - 0.7) / 0.3, 0, 1))  # 1 inside, soft edge beyond 0.7
    m = np.clip(m, 0, 1)
    m3 = m[:, :, None]

    work = master.copy()
    work[:, :, :3] = work[:, :, :3] * (1 - m3 * 0.85) + GREEN[None, None, :] * (m3 * 0.85)
    out = Image.fromarray(np.clip(work, 0, 255).astype(np.uint8), 'RGBA').convert('RGB')

    if is_leg:
        out = out.crop((0, 570, W, H))
    out_path = f'{BASE}/muscle-icons/{name}.png'
    out.save(out_path)
    print(f'  [{name}] wrote {out_path} {out.size}')
    return out_path

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--view', choices=['front', 'back'], required=True)
    ap.add_argument('--leg', action='store_true')
    args = ap.parse_args()
    build_icon(args.ref, args.name, args.view, args.leg)
