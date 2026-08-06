#!/usr/bin/env python3
"""Build calves + shoulders icons from the user's high-res images.
Crop around red highlight with generous padding, resize to 200x200.
Save as final named .png + preview-sync box_*.png (I=calves, J=shoulders)."""
import numpy as np
from PIL import Image
import os, shutil

BASE='/Users/jeffbruzzi/fitness-app'
ICON=200
PAD=90

def build(src_name, muscle, box):
    F=f'{BASE}/.hermes/desktop-attachments/{src_name}'
    img=Image.open(F).convert('RGB')
    W,H=img.size
    arr=np.array(img).astype(int)
    r,g,b=arr[:,:,0],arr[:,:,1],arr[:,:,2]
    red=(r>110)*(r>g+20)*(r>b+20)*(r<250)
    yy,xx=np.where(red)
    print(src_name,'size',W,H,'red px',len(xx),'x',xx.min(),xx.max(),'y',yy.min(),yy.max())
    x0=max(0,xx.min()-PAD);y0=max(0,yy.min()-PAD)
    x1=min(W,xx.max()+PAD);y1=min(H,yy.max()+PAD)
    crop=img.crop((x0,y0,x1,y1)); cw,ch=crop.size
    scale=ICON/max(cw,ch); nw,nh=int(cw*scale),int(ch*scale)
    crop=crop.resize((nw,nh),Image.LANCZOS)
    canvas=Image.new('RGB',(ICON,ICON),(247,248,250))
    canvas.paste(crop,((ICON-nw)//2,(ICON-nh)//2))
    canvas.save(f'{BASE}/muscle-icons/{muscle}.png')
    shutil.copy(f'{BASE}/muscle-icons/{muscle}.png', f'{BASE}/muscle-icons/box_{box}.png')
    print(f'  saved {muscle}.png + box_{box}.png: crop {cw}x{ch} -> {ICON}x{ICON}')

build('Calves Image.png','calves','I')
build('Shoulders Image.png','shoulders','J')
print('DONE - calves + shoulders')
