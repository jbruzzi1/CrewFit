#!/usr/bin/env python3
"""Build the biceps icon from the user's high-res Bicep Image.png.
Crop around the red highlight with generous padding, resize to 200x200.
Save as muscle-icons/biceps.png (final) and muscle-icons/box_D.png (preview sync)."""
import numpy as np
from PIL import Image
import os, shutil

BASE='/Users/jeffbruzzi/fitness-app'
F=f'{BASE}/.hermes/desktop-attachments/Bicep Image.png'
img=Image.open(F).convert('RGB')
W,H=img.size
arr=np.array(img).astype(int)
r,g,b=arr[:,:,0],arr[:,:,1],arr[:,:,2]
red=(r>110)*(r>g+20)*(r>b+20)*(r<250)
yy,xx=np.where(red)
print('size',W,H,'red px',len(xx),'x',xx.min(),xx.max(),'y',yy.min(),yy.max())
pad=90
x0=max(0,xx.min()-pad);y0=max(0,yy.min()-pad)
x1=min(W,xx.max()+pad);y1=min(H,yy.max()+pad)
crop=img.crop((x0,y0,x1,y1))
cw,ch=crop.size
ICON=200
scale=ICON/max(cw,ch)
nw,nh=int(cw*scale),int(ch*scale)
crop=crop.resize((nw,nh),Image.LANCZOS)
canvas=Image.new('RGB',(ICON,ICON),(247,248,250))
canvas.paste(crop,((ICON-nw)//2,(ICON-nh)//2))
canvas.save(f'{BASE}/muscle-icons/biceps.png')
shutil.copy(f'{BASE}/muscle-icons/biceps.png', f'{BASE}/muscle-icons/box_D.png')
print(f'saved biceps.png + box_D.png: crop {cw}x{ch} -> {ICON}x{ICON}')
