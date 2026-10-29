#!/usr/bin/env python3
"""Draws the favourites ranker's Home Screen icons: the card-ranker icon with a heart
instead of the sparkle, so the two apps are easy to tell apart."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "icons"  # favorites/icons


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw(size):
    s = 4 * size  # draw large, then downsample for smooth edges
    pink, lav, blue, mint = (255, 211, 234), (226, 214, 255), (211, 234, 255), (207, 245, 230)
    bg = Image.new("RGB", (s, s))
    px = bg.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s)
            px[x, y] = lerp(pink, lav, t / 0.4) if t < 0.4 else lerp(lav, blue, (t - 0.4) / 0.3) if t < 0.7 else lerp(blue, mint, (t - 0.7) / 0.3)
    img = bg.convert("RGBA")

    # Two fanned cards with a soft glow.
    def card(angle, fill, dx):
        layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        w, h = s * 0.42, s * 0.42 * 1.397
        x0, y0 = (s - w) / 2 + dx, (s - h) / 2 + s * 0.02
        d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.035, fill=fill, outline=(255, 255, 255, 255), width=round(s * 0.018))
        return layer.rotate(angle, resample=Image.BICUBIC, center=(s / 2, s * 0.62))

    glow = Image.new("RGBA", (s, s), (255, 255, 255, 0))
    ImageDraw.Draw(glow).ellipse([s * 0.2, s * 0.2, s * 0.8, s * 0.8], fill=(255, 255, 255, 150))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(s * 0.08)))
    img = Image.alpha_composite(img, card(14, (200, 180, 255, 255), -s * 0.06))
    img = Image.alpha_composite(img, card(-10, (255, 159, 208, 255), s * 0.05))

    # Heart on the front card.
    heart = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(heart)
    cx, cy, r = s * 0.555, s * 0.47, s * 0.068
    d.ellipse([cx - 2 * r, cy - r, cx, cy + r], fill=(255, 255, 255, 255))
    d.ellipse([cx, cy - r, cx + 2 * r, cy + r], fill=(255, 255, 255, 255))
    # Join the lobes at their outer tangent points (45° below centre) down to the tip.
    d.polygon([(cx - 1.707 * r, cy + 0.707 * r), (cx, cy - 0.2 * r), (cx + 1.707 * r, cy + 0.707 * r), (cx, cy + 2.5 * r)], fill=(255, 255, 255, 255))
    img = Image.alpha_composite(img, heart)
    return img.resize((size, size), Image.LANCZOS).convert("RGB")


OUT.mkdir(exist_ok=True)
draw(180).save(OUT / "apple-touch-icon.png")
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")
print("Wrote icons/")
