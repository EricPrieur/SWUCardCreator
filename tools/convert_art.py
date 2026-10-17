"""Make the site's copies of the card art: JPGs in public/art from the full-size
images in art-source/, which stays on this computer (it is not uploaded).

An image dropped straight into public/art as a PNG or WebP is moved to art-source
first, so either folder can be used to add art. One saved without an extension is
first given the right one.

Usage: python tools/convert_art.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "art-source"
SITE = ROOT / "public" / "art"
KINDS = {".png", ".webp", ".jpeg", ".jpg"}

SOURCE.mkdir(exist_ok=True)
for path in SITE.iterdir():
    if path.is_file() and not path.suffix:
        # Saved without an extension: named after what it really is
        try:
            kind = Image.open(path).format
        except OSError:
            continue
        path = path.replace(path.with_suffix("." + {"JPEG": "jpg"}.get(kind, kind.lower())))
    if path.suffix.lower() in KINDS and path.suffix.lower() != ".jpg":
        path.replace(SOURCE / path.name)
for path in sorted(SOURCE.iterdir()):
    if path.suffix.lower() not in KINDS:
        continue
    target = SITE / (path.stem + ".jpg")
    if target.exists() and target.stat().st_mtime >= path.stat().st_mtime:
        continue
    # Quality 85 looks the same on a card, at about a tenth of a PNG's size
    Image.open(path).convert("RGB").save(target, "JPEG", quality=85, optimize=True, progressive=True)
    print("wrote", target.name, target.stat().st_size // 1024, "KB")
