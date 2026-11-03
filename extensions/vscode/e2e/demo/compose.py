"""Compose recorded VS Code frames into a README demo GIF.

usage: compose.py <frames_dir> <out.gif>

<frames_dir> is what ReadmeDemo.test.ts wrote for one scene (frameNNNN.png plus
frames.json). Adds macOS window chrome (traffic lights, rounded corners, drop shadow) on a
white 1552x1080 canvas, draws keystroke badges, merges identical frames and
compresses idle time, then encodes with ffmpeg palettegen/paletteuse.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CANVAS = (1552, 1080)
WIN_W = 1340
RADIUS = 12
BADGE_FONT = "/System/Library/Fonts/SFNS.ttf"
SYMBOL_FONT = "/System/Library/Fonts/Apple Symbols.ttf"

src = Path(sys.argv[1])
out = Path(sys.argv[2])
meta = json.loads((src / "frames.json").read_text())
frames = meta["frames"]

first = Image.open(src / frames[0]["file"])
scale = WIN_W / first.width
WIN_H = round(first.height * scale)
ox = (CANVAS[0] - WIN_W) // 2
oy = (CANVAS[1] - WIN_H) // 2 - 10

# Static layers: background with drop shadow, and the rounded-corner mask.
bg = Image.new("RGB", CANVAS, "white")
shadow = Image.new("L", CANVAS, 0)
ImageDraw.Draw(shadow).rounded_rectangle(
    (ox, oy + 14, ox + WIN_W, oy + WIN_H + 14), RADIUS, fill=110
)
shadow = shadow.filter(ImageFilter.GaussianBlur(26))
bg.paste(Image.new("RGB", CANVAS, (0, 0, 0)), (0, 0), shadow)

mask = Image.new("L", (WIN_W, WIN_H), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, WIN_W - 1, WIN_H - 1), RADIUS, fill=255)


def chrome(win: Image.Image) -> Image.Image:
    d = ImageDraw.Draw(win)
    cy = round(19 * scale)  # in line with the title bar text
    for i, color in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        cx = 18 + i * 20
        d.ellipse((cx - 6, cy - 6, cx + 6, cy + 6), fill=color)
    d.rounded_rectangle((0, 0, WIN_W - 1, WIN_H - 1), RADIUS, outline=(70, 70, 70), width=1)
    return win


def badge(img: Image.Image, text: str) -> None:
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(BADGE_FONT, 34)
    sym = ImageFont.truetype(SYMBOL_FONT, 38)
    parts = [(ch, sym if ord(ch) > 0x2000 else font) for ch in text if ch != " "]
    widths = [d.textlength(ch, font=f) for ch, f in parts]
    gap = 12
    w = sum(widths) + gap * (len(parts) - 1) + 56
    h = 64
    x0 = (CANVAS[0] - w) / 2
    y0 = oy + WIN_H - h / 2
    d.rounded_rectangle((x0, y0, x0 + w, y0 + h), 14, fill=(20, 20, 20), outline=(90, 90, 90), width=2)
    x = x0 + 28
    for (ch, f), cw in zip(parts, widths):
        d.text((x, y0 + h / 2), ch, font=f, fill="white", anchor="lm")
        x += cw + gap


def compose(path: Path, badge_text: str | None) -> Image.Image:
    win = Image.open(path).convert("RGB").resize((WIN_W, WIN_H), Image.LANCZOS)
    win = chrome(win)
    img = bg.copy()
    img.paste(win, (ox, oy), mask)
    if badge_text:
        badge(img, badge_text)
    return img


tmp = src / "composed"
shutil.rmtree(tmp, ignore_errors=True)
tmp.mkdir(parents=True)

# Merge identical frames; durations from real timestamps, idle time compressed.
entries: list[list] = []  # [file, duration, small_change]
prev = None
for i, f in enumerate(frames):
    gap = (frames[i + 1]["t"] - f["t"]) / 1000 if i + 1 < len(frames) else 0
    img = compose(src / f["file"], f.get("badge"))
    arr = np.asarray(img)
    if prev is not None and np.array_equal(arr, prev):
        entries[-1][1] += gap
        continue
    small = prev is not None and (arr != prev).any(axis=2).mean() < 0.01
    prev = arr
    name = f"c{len(entries):04d}.png"
    img.save(tmp / name)
    entries.append([name, gap, small])

lines = []
for i, (name, gap, small) in enumerate(entries):
    if i == len(entries) - 1:
        d = 2.5
    elif small and gap < 0.5:
        d = min(gap, 0.07)  # typing and streaming tokens
    else:
        d = min(max(gap * 0.6, 0.08), 1.2)
    lines += [f"file '{name}'", f"duration {d:.3f}"]
lines.append(f"file '{entries[-1][0]}'")
(tmp / "list.txt").write_text("\n".join(lines) + "\n")

total = sum(float(l.split()[1]) for l in lines if l.startswith("duration"))
print(f"{len(frames)} frames -> {len(entries)} unique, {total:.1f}s")

subprocess.run(
    [
        "ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"),
        "-vf", "fps=15,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
        str(out),
    ],
    check=True,
)
print(out, f"{out.stat().st_size / 1e6:.2f} MB")
