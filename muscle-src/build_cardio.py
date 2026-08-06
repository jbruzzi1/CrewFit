#!/usr/bin/env python3
"""Build cardio icon. The Cardio Image is a GRAYSCALE line-figure (no red highlight),
unlike the muscle images. Crop to the figure's content bbox, resize to 200x200.
User requested NO red tint: the figure stays grayscale (dark gray) on the app
background. Save as cardio.png (final) + box_M.png (preview sync; final plan M=cardio)."""
import numpy as np
from PIL import Image
import os, shutil

BASE='/Users/jeffbruzzi/fitness-app'
F=f'{BASE}/.hermes/desktop-attachments/Cardio Image.png'
img=Image.open(F).convert('RGB')
W,H=img.size
arr=np.array(img).astype(int)
# content = pixels darker than the ~238 near-white background
dark=(arr[:,:,0]<218)|(arr[:,:,1]<218)|(arr[:,:,2]<218)
yy,xx=np.where(dark)
print('size',W,H,'content px',len(xx),'x',xx.min(),xx.max(),'y',yy.min(),yy.max())
pad=70
x0=max(0,xx.min()-pad);y0=max(0,yy.min()-pad)
x1=min(W,xx.max()+pad);y1=min(H,yy.max()+pad)
crop=img.crop((x0,y0,x1,y1)).convert('RGB')
cw,ch=crop.size

# Keep the figure grayscale (dark gray) on the app background (247,248,250). NO red.
ca=np.array(crop).astype(int)
cdark=(ca[:,:,0]<218)|(ca[:,:,1]<218)|(ca[:,:,2]<218)
out_c=np.full((ch,cw,3),247,dtype=np.uint8).astype(int)   # app bg
# preserve the original grayscale darkness of the figure (don't force pure black)
fig=ca[cdark]
gray=fig.mean(axis=1).astype(int)
out_c[cdark]=np.stack((gray,gray,gray),axis=1)
out=Image.fromarray(out_c.astype(np.uint8)).convert('RGB')
ICON=200
scale=ICON/max(cw,ch)
nw,nh=int(cw*scale),int(ch*scale)
out=out.resize((nw,nh),Image.LANCZOS)
canvas=Image.new('RGB',(ICON,ICON),(247,248,250))
canvas.paste(out,((ICON-nw)//2,(ICON-nh)//2))
canvas.save(f'{BASE}/muscle-icons/cardio.png')
shutil.copy(f'{BASE}/muscle-icons/cardio.png', f'{BASE}/muscle-icons/box_M.png')
shutil.copy(f'{BASE}/muscle-icons/cardio.png', f'{BASE}/public/muscle-icons/cardio.png')
print(f'saved cardio.png + box_M.png + public/cardio.png: cropped figure {cw}x{ch} -> grayscale (no red) -> {ICON}x{ICON}')
