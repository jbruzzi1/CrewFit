from PIL import Image, ImageDraw
import numpy as np
from collections import deque
BASE='/Users/jeffbruzzi/fitness-app'
mf=np.array(Image.open(BASE+'/muscle-src/master-shoulders.png').convert('RGBA')).astype(np.float32)
mb=np.array(Image.open(BASE+'/muscle-src/master-back.png').convert('RGBA')).astype(np.float32)

def mask(src):
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
    k=12; eroded=np.zeros_like(body); ys,xs=np.where(body)
    if len(ys):
        y0,y1=max(0,ys.min()-k),min(H,ys.max()+k); x0,x1=max(0,xs.min()-k),min(W,xs.max()+k)
        sub=body[y0:y1,x0:x1].copy()
        for _ in range(k):
            p=np.pad(sub,1,mode='constant',constant_values=0)
            sub=np.minimum(np.minimum(p[:-2,:-2],p[:-2,1:-1]),np.minimum(np.minimum(p[:-2,2:],p[1:-1,:-2]),np.minimum(np.minimum(p[1:-1,2:],p[2:,:-2]),np.minimum(p[2:,1:-1],p[2:,2:]))))
        eroded[y0:y1,x0:x1]=sub
    return body, eroded

bf,mf_e=mask(mf); bb,mb_e=mask(mb)
front_rgb=mf; back_rgb=mb
GREEN=np.array([22,163,74],np.float32)
def radial(H,W,cx,cy,rx,ry,f=0.5):
    yy,xx=np.mgrid[0:H,0:W]
    d=np.sqrt(((xx-cx)/rx)**2+((yy-cy)/ry)**2)
    return 1.0-np.clip((d-(1-f))/f,0,1)
def comp(src,maskd,specs,debug=False):
    H,W,_=src.shape
    out={}
    for name,ells in specs.items():
        work=src.copy(); m=np.zeros((H,W),np.float32)
        for cx,cy,rx,ry in ells: m=np.maximum(m,radial(H,W,cx,cy,rx,ry))
        m=m*maskd.astype(np.float32); m3=m[:,:,None]
        work[:,:,:3]=work[:,:,:3]*(1-m3*0.9)+GREEN[None,None,:]*(m3*0.9)
        im=Image.fromarray(np.clip(work,0,255).astype(np.uint8),'RGBA').convert('RGB')
        if debug:
            d=ImageDraw.Draw(im)
            for cx,cy,rx,ry in ells:
                d.line([(cx-18,cy),(cx+18,cy)],fill=(255,0,0),width=3)
                d.line([(cx,cy-18),(cx,cy+18)],fill=(255,0,0),width=3)
                d.ellipse([cx-5,cy-5,cx+5,cy+5],fill=(255,0,0))
        out[name]=im
    return out
FR={'chest':[(512,470,150,95)],'shoulders':[(360,400,80,70),(664,400,80,70)],'biceps':[(330,520,52,110),(694,520,52,110)],'forearms':[(300,660,46,100),(724,660,46,100)],'abs':[(512,600,95,95)],'core':[(512,600,130,140)],'quads':[(420,820,95,130),(604,820,95,130)],'cardio':[(512,470,80,80)]}
BA={'triceps':[(360,520,52,110),(694,520,52,110)]}
front=comp(front_rgb,mf_e,FR,debug=True); back=comp(back_rgb,mb_e,BA,debug=True)
for n,im in {**front,**back}.items(): im.save(f'{BASE}/muscle-icons/dbg-{n}.png')
# body mask viz
for tag,body in [('body-mask',bf),('body-mask-back',bb)]:
    H,W=body.shape
    viz=np.ones((H,W,3),np.uint8)*220; viz[body]=255
    Image.fromarray(viz,'RGB').save(f'{BASE}/muscle-icons/{tag}.png')
print('debug overlays + body masks written')
