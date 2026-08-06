import json, os
from PIL import Image, ImageDraw
import numpy as np
from collections import deque

BASE='/Users/jeffbruzzi/fitness-app'
MARKS=json.load(open(BASE+'/muscle-src/muscle-marks.json'))
GREEN=np.array([22,163,74],np.float32)

def body_mask(src):
    H,W,_=src.shape
    lum=src[:,:,:3].mean(axis=2); bg=src[0,0].mean()
    vis=np.zeros((H,W),bool); q=deque()
    for c in[(0,0),(0,W-1),(H-1,0),(H-1,W-1)]: vis[c]=True;q.append(c)
    while q:
        y,x=q.popleft()
        for dy,dx in((1,0),(-1,0),(0,1),(0,-1)):
            ny,nx=y+dy,x+dx
            if 0<=ny<H and 0<=nx<W and not vis[ny,nx] and abs(lum[ny,nx]-bg)<=26:
                vis[ny,nx]=True;q.append((ny,nx))
    body=~vis
    k=10; ero=np.zeros_like(body); ys,xs=np.where(body)
    if len(ys):
        y0,y1=max(0,ys.min()-k),min(H,ys.max()+k); x0,x1=max(0,xs.min()-k),min(W,xs.max()+k)
        sub=body[y0:y1,x0:x1].copy()
        for _ in range(k):
            p=np.pad(sub,1,mode='constant',constant_values=0)
            sub=np.minimum(np.minimum(p[:-2,:-2],p[:-2,1:-1]),np.minimum(np.minimum(p[:-2,2:],p[1:-1,:-2]),np.minimum(np.minimum(p[1:-1,2:],p[2:,:-2]),np.minimum(p[2:,1:-1],p[2:,2:]))))
        ero[y0:y1,x0:x1]=sub
    return body, ero

def paint_mask(points, H, W, feather=18):
    # build a filled polygon mask from the user's stroke outline
    img=Image.new('L',(W,H),0)
    d=ImageDraw.Draw(img)
    pts=[(int(x),int(y)) for x,y in points]
    if len(pts)>=3:
        # close the loop
        d.polygon(pts, fill=255)
    mask=np.array(img)>0
    # dilate a bit to cover interior gaps (user traced outline)
    for _ in range(6):
        p=np.pad(mask.astype(np.uint8),1,mode='constant',constant_values=0)
        mask=np.minimum(np.minimum(p[:-2,:-2],p[:-2,1:-1]),np.minimum(np.minimum(p[:-2,2:],p[1:-1,:-2]),np.minimum(np.minimum(p[1:-1,2:],p[2:,:-2]),np.minimum(p[2:,1:-1],p[2:,2:]))))>0
    # blur for soft edge
    from PIL import ImageFilter
    soft=Image.fromarray((mask*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(feather))
    return (np.array(soft)/255.0)

front_src=np.array(Image.open(BASE+'/muscle-src/master-shoulders.png').convert('RGBA')).astype(np.float32)
back_src=np.array(Image.open(BASE+'/muscle-src/master-back.png').convert('RGBA')).astype(np.float32)
bf,bfe=body_mask(front_src); bb,bbe=body_mask(back_src)
H,W=bf.shape

def apply(src, ero, name, points):
    work=src.copy()
    if points and len(points)>=3:
        m=paint_mask(points,H,W)*ero.astype(np.float32)
    else:
        m=np.zeros((H,W),np.float32)
    m3=m[:,:,None]
    work[:,:,:3]=work[:,:,:3]*(1-m3*0.85)+GREEN[None,None,:]*(m3*0.85)
    return Image.fromarray(np.clip(work,0,255).astype(np.uint8),'RGBA').convert('RGB')

out={}
for n in ['chest','shoulders','biceps','forearms','abs','core']:
    out[n]=apply(front_src,bfe,n,MARKS['front'].get(n,[]))
for n in ['triceps']:
    out[n]=apply(back_src,bbe,n,MARKS['back'].get(n,[]))
# quads + cardio not painted -> gentle default ellipses on body
def ellipse(src,ero,cx,cy,rx,ry):
    work=src.copy(); yy,xx=np.mgrid[0:H,0:W]
    d=np.sqrt(((xx-cx)/rx)**2+((yy-cy)/ry)**2); m=(1.0-np.clip((d-0.5)/0.5,0,1))*ero.astype(np.float32)
    m3=m[:,:,None]; work[:,:,:3]=work[:,:,:3]*(1-m3*0.85)+GREEN[None,None,:]*(m3*0.85)
    return Image.fromarray(np.clip(work,0,255).astype(np.uint8),'RGBA').convert('RGB')
out['quads']=ellipse(front_src,bfe,512,820,170,120)
out['cardio']=ellipse(front_src,bfe,512,470,80,80)
os.makedirs(BASE+'/muscle-icons',exist_ok=True)
for n,im in out.items():
    im.save(BASE+f'/muscle-icons/{n}.png'); print('wrote',n)
print('DONE')
