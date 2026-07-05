"""Generate crisp QuorixASP logo assets from the real ring-Q source PNG."""
from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "logo"
LOCAL_SRC = OUT / "logo-source.png"
PROOF = OUT / "proof"
BG = (11, 11, 11, 255)  # #0B0B0B — brand background for favicons


def load_source() -> Image.Image:
    if not LOCAL_SRC.exists():
        raise FileNotFoundError(
            f"Place the ring-Q source PNG at {LOCAL_SRC} before running this script."
        )
    return Image.open(LOCAL_SRC).convert("RGBA")


def key_black_to_alpha(img: Image.Image, threshold: int = 40) -> Image.Image:
    rgba = img.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r <= threshold and g <= threshold and b <= threshold:
                px[x, y] = (255, 255, 255, 0)
            else:
                px[x, y] = (255, 255, 255, 255)
    return rgba


def square_crop(img: Image.Image, margin_ratio: float = 0.12) -> Image.Image:
    alpha = img.split()[-1]
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError("Logo has no visible pixels after transparency pass")
    cropped = img.crop(bbox)
    cw, ch = cropped.size
    side = int(max(cw, ch) * (1 + margin_ratio * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ox = (side - cw) // 2
    oy = (side - ch) // 2
    canvas.paste(cropped, (ox, oy), cropped)
    return canvas


def resize_crisp(master: Image.Image, size: int) -> Image.Image:
    """Supersample down for thin line art."""
    scale = 4 if size <= 32 else 2
    big = master.resize((size * scale, size * scale), Image.Resampling.LANCZOS)
    if scale > 1:
        big = big.filter(ImageFilter.UnsharpMask(radius=1.2, percent=180, threshold=2))
    return big.resize((size, size), Image.Resampling.LANCZOS)


def on_brand_bg(transparent: Image.Image, size: int) -> Image.Image:
    fg = resize_crisp(transparent, size)
    bg = Image.new("RGBA", (size, size), BG)
    bg.alpha_composite(fg)
    return bg.convert("RGB")


def save_png(img: Image.Image, path: Path):
    img.save(path, format="PNG", optimize=True)


def write_ico(transparent: Image.Image, path: Path):
    """ICO must use solid #0B0B0B — transparent ICO is invisible on light tab chrome."""
    ico_32 = on_brand_bg(transparent, 32)
    ico_16 = on_brand_bg(transparent, 16)
    ico_32.save(path, format="ICO", sizes=[(16, 16), (32, 32)], append_images=[ico_16])


def ico_image_count(path: Path) -> int:
    data = path.read_bytes()
    return struct.unpack("<HHH", data[:6])[2]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PROOF.mkdir(parents=True, exist_ok=True)

    src = load_source()
    transparent = square_crop(key_black_to_alpha(src))
    transparent.save(OUT / "logo-transparent.png", optimize=True)

    header = on_brand_bg(transparent, 128)
    header.save(OUT / "logo-header.png", optimize=True)

    sizes = {
        "favicon-16x16.png": 16,
        "favicon-32x32.png": 32,
        "apple-touch-icon.png": 180,
        "favicon-512x512.png": 512,
    }
    for name, size in sizes.items():
        save_png(on_brand_bg(transparent, size), OUT / name)

    write_ico(transparent, ROOT / "favicon.ico")

    # Proof sheet — open these directly to verify crisp ring-Q
    for name, size in [("proof-16.png", 16), ("proof-32.png", 32), ("proof-180.png", 180)]:
        save_png(on_brand_bg(transparent, size), PROOF / name)

    proof_sheet = Image.new("RGB", (16 + 32 + 180 + 40, 180), (11, 11, 11))
    x = 10
    for size in (16, 32, 180):
        tile = on_brand_bg(transparent, size)
        proof_sheet.paste(tile, (x, (180 - size) // 2))
        x += size + 10
    proof_sheet.save(PROOF / "favicon-proof-sheet.png", optimize=True)

    print("Source:", LOCAL_SRC)
    print("Master square:", transparent.size)
    print("ICO images:", ico_image_count(ROOT / "favicon.ico"))
    for p in sorted(OUT.rglob("*.png")):
        print(f"  {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()