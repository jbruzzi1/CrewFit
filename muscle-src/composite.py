import sys, os
from PIL import Image, ImageDraw
import numpy as np
from collections import deque

MASTER_FRONT = '/Users/jeffbruzzi/fitness-app/muscle-src/master-shoulders.png'
MASTER_BACK  = '/Users/jeffbruzzi/fitness-app/muscle-src/master-back.png'
OUTDIR = '/Users/jeffbruzzi/fitness-app/muscle-icons'
GREEN = np.array([22, 163, 74], np.float32)

def body_mask(path):
    base = np.array(Image.open(path).convert('RGBA')).astype(np.float32)
    H, W, _ = base.shape
    lum = base[:, :, :3].mean(axis=2)
    bg = base[0, 0].mean()
    vis = np.zeros((H, W), bool); q = deque()
    for c in [(0,0),(0,W-1),(H-1,0),(H-1,W-1)]:
        vis[c] = True; q.append(c)
    while q:
        y, x = q.popleft()
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            ny, nx = y+dy, x+dx
            if 0<=ny<H and 0<=nx<W and not vis[ny,nx] and abs(lum[ny,nx]-bg) <= 26:
                vis[ny,nx]=True; q.append((ny,nx))
    body = ~vis
    # erode so green stops ~12px inside the silhouette (kills shoulder/outer-thigh rim)
    k = 12
    eroded = np.zeros_like(body)
    ys, xs = np.where(body)
    if len(ys):
        y0, y1 = max(0, ys.min()-k), min(H, ys.max()+k)
        x0, x1 = max(0, xs.min()-k), min(W, xs.max()+k)
        # binary erosion via iterative min-filter (no scipy needed)
        sub = body[y0:y1, x0:x1].copy()
        for _ in range(k):
            padded = np.pad(sub, 1, mode='constant', constant_values=0)
            win = np.minimum(np.minimum(padded[:-2, :-2], padded[:-2, 1:-1]),
                             np.minimum(np.minimum(padded[:-2, 2:], padded[1:-1, :-2]),
                                        np.minimum(np.minimum(padded[1:-1, 2:], padded[2:, :-2]),
                                                   np.minimum(padded[2:, 1:-1], padded[2:, 2:]))))
            sub = win
        eroded[y0:y1, x0:x1] = sub
    return base, eroded

def radial(H, W, cx, cy, rx, ry, feather=0.5):
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt(((xx-cx)/rx)**2 + ((yy-cy)/ry)**2)
    return 1.0 - np.clip((d-(1-feather))/feather, 0, 1)

def composite(base, mask, specs, debug=False):
    H, W = base.shape[:2]
    out_imgs = {}
    for name, ellipses in specs.items():
        work = base.copy()
        m = np.zeros((H, W), np.float32)
        for (cx, cy, rx, ry) in ellipses:
            m = np.maximum(m, radial(H, W, cx, cy, rx, ry))
        m = m * mask.astype(np.float32)
        m3 = m[:, :, None]
        work[:, :, :3] = work[:, :, :3]*(1-m3*0.9) + GREEN[None,None,:]*(m3*0.9)
        img = Image.fromarray(np.clip(work,0,255).astype(np.uint8), 'RGBA').convert('RGB')
        if debug:
            d = ImageDraw.Draw(img)
            for (cx, cy, rx, ry) in ellipses:
                d.line([(cx-18,cy),(cx+18,cy)], fill=(255,0,0), width=3)
                d.line([(cx,cy-18),(cx,cy+18)], fill=(255,0,0), width=3)
                d.ellipse([cx-5,cy-5,cx+5,cy+5], fill=(255,0,0))
        out_imgs[name] = img
    return out_imgs

bf, mf = body_mask(MASTER_FRONT)
bb, mb = body_mask(MASTER_BACK)

# Corrected coords (front master). Bilateral = both sides.
FRONT_SPECS = {
    'chest':     [(512, 470, 150, 95)],
    'shoulders': [(360, 400, 80, 70), (664, 400, 80, 70)],
    'biceps':    [(330, 520, 52, 110), (694, 520, 52, 110)],
    'forearms':  [(300, 660, 46, 100), (724, 660, 46, 100)],
    'abs':       [(512, 600, 95, 95)],
    'core':      [(512, 600, 130, 140)],
    'quads':     [(420, 820, 95, 130), (604, 820, 95, 130)],
    'cardio':    [(512, 470, 80, 80)],
}
BACK_SPECS = {
    'triceps':   [(360, 520, 52, 110), (694, 520, 52, 110)],
}

os.makedirs(OUTDIR, exist_ok=True)
for n, im in composite(bf, mf, FRONT_SPECS).items():
    im.save(os.path.join(OUTDIR, f'{n}.png')); print('wrote', n)
for n, im in composite(bb, mb, BACK_SPECS).items():
    im.save(os.path.join(OUTDIR, f'{n}.png')); print('wrote', n)
print('DONE')
