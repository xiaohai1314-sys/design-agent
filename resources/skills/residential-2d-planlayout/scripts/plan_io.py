"""File contracts for the residential plan tools."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageFont


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def open_image(path):
    with Image.open(path) as image:
        return image.convert("RGBA")


def new_png(path):
    path = Path(path).resolve()
    if path.suffix.lower() != ".png" or path.exists():
        raise ValueError(f"Choose a new PNG output file: {path}")
    return path


def save_png(image, path):
    with new_png(path).open("xb") as stream:
        image.save(stream, "PNG")


def font(size, chinese=False):
    names = (
        [
            "msyh.ttc",
            "simsun.ttc",
            "PingFang.ttc",
            "Hiragino Sans GB.ttc",
            "STHeiti Medium.ttc",
            "NotoSansSC-VF.ttf",
            "NotoSansCJK-Regular.ttc",
            "Arial Unicode.ttf",
        ]
        if chinese
        else []
    )
    for name in [*names, "Arial.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def write_json(path, data):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(data, stream, allow_nan=False)
        stream.write("\n")


def script_args(options):
    for key, value in options.items():
        if value is True:
            yield "--" + key.replace("_", "-")
        elif value is not None and value is not False:
            yield "--" + key.replace("_", "-")
            yield str(value)


def run_script(name, *args, allowed=(0,), **options):
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-X",
            "utf8",
            str(Path(__file__).with_name(name + ".py")),
            *map(str, args),
            *script_args(options),
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode not in allowed:
        raise ValueError(
            result.stderr.strip() or result.stdout.strip() or f"{name} failed."
        )
    return result.stdout.strip()


def identity_geometry(size, edits):
    w, h = size
    corners = [(0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)]
    return {"anchors": [{"base": p, "candidate": p} for p in corners], "edits": edits}


def copy_new(source, destination):
    from shutil import copyfileobj

    with Path(source).open("rb") as original, Path(destination).open("xb") as output:
        copyfileobj(original, output)


def rect_polygon(rect):
    l, t, r, b = rect
    return {"points": [(l, t), (r, t), (r, b), (l, b)]}
