"""
PNG -> raw RGBA, so the TypeScript reader can be tested in Node without a PNG
decoder and without a dependency.

The reader takes `RgbaImage`, which is structurally `ImageData`. In the browser
that comes free off a canvas. In Node there is no canvas, and pulling in a PNG
decoder to test a module that will never decode a PNG in production is the kind
of dependency that ends up in the shipped bundle. So the corpus is converted
once, here, and the reader is tested on exactly the bytes a browser would hand
it.
"""
import json, sys, os
from PIL import Image

src = sys.argv[1]
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
manifest = []
for name in sorted(os.listdir(src)):
    if not name.lower().endswith(".png"):
        continue
    m = None
    if name.startswith("Screenshot (") and name.endswith(").png"):
        try:
            m = int(name[len("Screenshot ("):-len(").png")])
        except ValueError:
            m = None
    if m is None:
        continue
    im = Image.open(os.path.join(src, name)).convert("RGBA")
    raw = f"f{m}.raw"
    im.tobytes() and open(os.path.join(out, raw), "wb").write(im.tobytes())
    manifest.append({"frame": m, "file": raw, "width": im.width, "height": im.height})
manifest.sort(key=lambda r: r["frame"])
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
print(f"{len(manifest)} frames -> {out}")
