import subprocess, sys

# Measures where the bright text rows sit in a rendered frame (PNG -> gray rows),
# so the layout can be verified without a vision model.
def gray_rows(png, W=1280, H=720):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                       capture_output=True)
    buf = p.stdout
    assert len(buf) == W*H, f'got {len(buf)} bytes, expected {W*H}'
    rows = []
    for y in range(H):
        row = buf[y*W:(y+1)*W]
        rows.append(sum(row)/W)
    return buf, rows

def bands(rows, thr=45, minlen=3):
    out = []
    start = None
    for y, v in enumerate(rows + [0]):
        if v >= thr and start is None:
            start = y
        elif v < thr and start is not None:
            if y - start >= minlen:
                out.append((start, y-1, round(max(rows[start:y]), 1)))
            start = None
    return out

for png in sys.argv[1:]:
    buf, rows = gray_rows(png)
    print('===', png)
    print(' background sample (row 400 mean):', round(rows[400], 1), '| row 200:', round(rows[200], 1))
    for b in bands(rows):
        y0, y1, mx = b
        # horizontal extent of the bright pixels inside that band
        xs = []
        for y in range(y0, y1+1):
            row = buf[y*1280:(y+1)*1280]
            idx = [x for x, v in enumerate(row) if v > 90]
            if idx:
                xs.append((min(idx), max(idx)))
        if xs:
            l = min(a for a, _ in xs)
            r = max(b for _, b in xs)
        else:
            l = r = -1
        print(f'  band y={y0}-{y1} (h={y1-y0+1}) max={mx} x={l}..{r}')
