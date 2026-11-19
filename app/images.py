import io
import re
import secrets
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .util import ApiError

Image.MAX_IMAGE_PIXELS = 40_000_000  # reject decompression bombs
ALLOWED = {"JPEG", "PNG", "WEBP"}
NAME_RE = re.compile(r"^[0-9a-f]{32}\.jpg$")


def save_nominee_image(file_storage, upload_dir, max_mb):
    """Validate by decoding (not by extension or Content-Type), strip metadata, downscale,
    and store under a random name. Returns the stored file name."""
    limit = max_mb * 1024 * 1024
    data = file_storage.read(limit + 1)
    if not data:
        raise ApiError(422, "The uploaded image is empty.")
    if len(data) > limit:
        raise ApiError(413, f"Image must be {max_mb} MB or smaller.")
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.format not in ALLOWED:
            raise ApiError(422, "Only PNG, JPG or WEBP images are accepted.")
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
            backdrop = Image.new("RGB", img.size, (255, 255, 255))
            backdrop.paste(img, mask=img.getchannel("A"))
            img = backdrop
        else:
            img = img.convert("RGB")
        img.thumbnail((900, 900))
    except ApiError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ApiError(422, "That file is not a valid image.")

    name = secrets.token_hex(16) + ".jpg"
    path = Path(upload_dir)
    path.mkdir(parents=True, exist_ok=True)
    img.save(path / name, "JPEG", quality=85, optimize=True, progressive=True)  # no EXIF written
    return name


def delete_image(upload_dir, name):
    if name and NAME_RE.match(name):
        try:
            (Path(upload_dir) / name).unlink()
        except FileNotFoundError:
            pass
