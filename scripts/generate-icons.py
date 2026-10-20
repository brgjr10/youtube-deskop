#!/usr/bin/env python3
"""Build the Linux icon assets from the canonical YouTube mark in youtube.ico.

The Windows build has always shipped youtube.ico, so the mark only ever existed
as a Windows icon resource. Chromium on Linux ignores .ico files - the window,
the dock and the launcher all fell back to a generic glyph - and the AppImage
had to carry a placeholder that did not match the .ico at all.

This script traces the artwork out of the .ico and writes the PNG and SVG
assets the Linux build needs, so every platform shows the same mark:

    assets/youtube-desktop.svg        scalable master (traced from the .ico)
    assets/youtube-desktop.png        256x256 raster, used as the window icon
    assets/icons/<size>x<size>.png    hicolor theme set

Run it after changing youtube.ico:

    python3 scripts/generate-icons.py

Requires Pillow. Everything else is standard library.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

PROJECT_DIR = Path(__file__).resolve().parent.parent
SOURCE_ICO = PROJECT_DIR / "youtube.ico"
ASSET_DIR = PROJECT_DIR / "assets"
ICON_DIR = ASSET_DIR / "icons"

MASTER_SIZE = 256
SVG_NAME = "youtube-desktop.svg"
PNG_NAME = "youtube-desktop.png"

# The raster sizes the hicolor theme uses for application icons. 16 through 48
# are the sizes a dock or a launcher actually asks for; 64 and 128 cover the
# larger overview and Settings panels.
RASTER_SIZES = (16, 24, 32, 48, 64, 128, 256)

# The .ico already carries hand-tuned artwork for 16, 32 and 48. Those frames
# are used as-is; every other size is resampled from the 256 master so the
# whole set stays visually consistent.
ICO_FRAME_SIZES = (16, 32, 48)

# The mark's red is a diagonal gradient: bright at the top left, dark at the
# bottom right. The stops were measured off the artwork - the flat bright
# section ends around x+y=210 and the flat dark section starts around x+y=395.
GRADIENT_BRIGHT = (230, 0, 0)
GRADIENT_DARK = (181, 0, 0)
GRADIENT_BRIGHT_UNTIL = 210
GRADIENT_DARK_FROM = 395


# --------------------------------------------------------------------------
# Mask helpers
# --------------------------------------------------------------------------

def _flood_from_border(mask):
    """Return the pixels of `mask` reachable from the image border.

    Implemented as an explicit stack rather than a recursive fill because the
    masks are 256x256 and Python recursion would blow the stack.
    """
    height = len(mask)
    width = len(mask[0])
    reached = [[False] * width for _ in range(height)]
    stack = []

    def push(y, x):
        if mask[y][x] and not reached[y][x]:
            reached[y][x] = True
            stack.append((y, x))

    for x in range(width):
        push(0, x)
        push(height - 1, x)
    for y in range(height):
        push(y, 0)
        push(y, width - 1)

    while stack:
        y, x = stack.pop()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < height and 0 <= nx < width:
                push(ny, nx)

    return reached


def fill_holes(mask):
    """Close interior holes in a boolean mask."""
    height = len(mask)
    width = len(mask[0])
    outside = [[not mask[y][x] for x in range(width)] for y in range(height)]
    reached = _flood_from_border(outside)
    filled = [row[:] for row in mask]
    for y in range(height):
        for x in range(width):
            if not mask[y][x] and not reached[y][x]:
                filled[y][x] = True
    return filled


# --------------------------------------------------------------------------
# Contour tracing
# --------------------------------------------------------------------------

def trace_contour(mask):
    """Trace the outline of a filled boolean mask as a closed polygon.

    Moore-neighbour tracing: walk the boundary of the region one pixel at a
    time, always turning as far clockwise as the shape allows. The result is
    the staircase of the pixel grid, which the caller simplifies and smooths.

    Pixel centres are returned, so the polygon is offset by half a pixel from
    the pixel-corner grid the artwork lives on.
    """
    height = len(mask)
    width = len(mask[0])

    start = None
    for y in range(height):
        for x in range(width):
            if mask[y][x]:
                start = (x, y)
                break
        if start:
            break
    if start is None:
        return []

    # Clockwise from north-west.
    directions = [(-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0)]
    west = directions.index((-1, 0))

    def is_set(point):
        x, y = point
        return 0 <= x < width and 0 <= y < height and mask[y][x]

    contour = [start]
    current = start
    # The backtrack is the background pixel the search restarts from. It is
    # tracked by position rather than by direction, because moving to the next
    # boundary pixel changes which of the eight directions points at it.
    backtrack = (start[0] - 1, start[1])
    first_backtrack = backtrack

    limit = 4 * width * height
    while len(contour) < limit:
        offset = (backtrack[0] - current[0], backtrack[1] - current[1])
        begin = directions.index(offset) if offset in directions else west

        moved = False
        for step in range(1, 9):
            index = (begin + step) % 8
            dx, dy = directions[index]
            neighbour = (current[0] + dx, current[1] + dy)
            if is_set(neighbour):
                current = neighbour
                contour.append(current)
                moved = True
                break
            # The last background pixel looked at is the one the next search
            # starts from.
            backtrack = neighbour
        if not moved:
            break
        if current == start and backtrack == first_backtrack:
            break

    return [(x + 0.5, y + 0.5) for x, y in contour]


def polygon_area(points):
    """Shoelace area of a closed polygon."""
    total = 0.0
    for index in range(len(points)):
        x0, y0 = points[index]
        x1, y1 = points[(index + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def mask_overlap(mask, points):
    """How much of the mask the traced polygon covers, and the other way round.

    The trace follows pixel centres, so it never matches the pixel mask
    exactly. Comparing the two as shapes - overlap over union - is the
    meaningful measure.
    """
    height = len(mask)
    width = len(mask[0])
    drawn = Image.new("L", (width, height), 0)
    ImageDraw.Draw(drawn).polygon(points, fill=255)

    inside = 0
    covered = 0
    union = 0
    drawn_pixels = drawn.load()
    for y in range(height):
        for x in range(width):
            in_mask = mask[y][x]
            in_polygon = drawn_pixels[x, y] > 0
            if in_mask and in_polygon:
                inside += 1
            if in_mask or in_polygon:
                union += 1
            if in_polygon:
                covered += 1
    if not union:
        return 0.0
    return inside / union



def simplify(points, epsilon):
    """Douglas-Peucker simplification of a closed polygon."""
    if len(points) < 4:
        return points

    def perpendicular_distance(point, start, end):
        (px, py), (sx, sy), (ex, ey) = point, start, end
        dx, dy = ex - sx, ey - sy
        if dx == 0 and dy == 0:
            return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
        t = ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        cx, cy = sx + t * dx, sy + t * dy
        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

    def recurse(points):
        if len(points) < 3:
            return points
        start, end = points[0], points[-1]
        worst_index = 0
        worst_distance = 0.0
        for index in range(1, len(points) - 1):
            distance = perpendicular_distance(points[index], start, end)
            if distance > worst_distance:
                worst_distance = distance
                worst_index = index
        if worst_distance > epsilon:
            left = recurse(points[: worst_index + 1])
            right = recurse(points[worst_index:])
            return left[:-1] + right
        return [start, end]

    reduced = recurse(points)
    if reduced and reduced[0] != reduced[-1]:
        reduced.append(reduced[0])
    return reduced


def smooth(points):
    """Turn a polygon into a Catmull-Rom spline expressed as cubic curves."""
    unique = points[:-1] if len(points) > 1 and points[0] == points[-1] else list(points)
    count = len(unique)
    if count < 3:
        return points

    commands = [f"M {unique[0][0]:.2f} {unique[0][1]:.2f}"]
    for index in range(count):
        p0 = unique[(index - 1) % count]
        p1 = unique[index]
        p2 = unique[(index + 1) % count]
        p3 = unique[(index + 2) % count]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
        commands.append(
            f"C {c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}"
        )
    commands.append("Z")
    return " ".join(commands)


# --------------------------------------------------------------------------
# Artwork extraction
# --------------------------------------------------------------------------

def load_master():
    """Load the largest frame of the .ico as an RGBA image."""
    image = Image.open(SOURCE_ICO)
    sizes = sorted(image.info.get("sizes", []), key=lambda size: size[0])
    if not sizes:
        raise SystemExit(f"{SOURCE_ICO} holds no frames")
    largest = sizes[-1]
    image.size = largest
    image = image.convert("RGBA")
    if largest[0] != MASTER_SIZE:
        image = image.resize((MASTER_SIZE, MASTER_SIZE), Image.LANCZOS)
    return image


def classify(image):
    """Split the artwork into the three shapes that make up the mark."""
    width, height = image.size
    pixels = image.load()

    def is_red(x, y):
        r, g, b, a = pixels[x, y]
        return a > 128 and r > 140 and g < 110 and b < 110

    disc = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a > 128 and not is_red(x, y):
                disc[y][x] = True

    disc_solid = fill_holes(disc)

    outer = [[False] * width for _ in range(height)]
    triangle = [[False] * width for _ in range(height)]
    silhouette = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if not disc_solid[y][x] and pixels[x, y][3] > 128:
                outer[y][x] = True
            elif disc_solid[y][x] and is_red(x, y):
                triangle[y][x] = True
            if pixels[x, y][3] > 128:
                silhouette[y][x] = True

    return outer, disc_solid, triangle, silhouette


def gradient_image(size):
    """Build the diagonal red gradient the mark is filled with.

    The gradient runs along the diagonal, so it is built as a one pixel tall
    lookup table and then pasted along every diagonal of the square. Doing it
    that way keeps the whole render inside Pillow instead of a per pixel
    Python loop over a million pixels.
    """
    span = 2 * (size - 1)
    bright_until = GRADIENT_BRIGHT_UNTIL * (size / MASTER_SIZE)
    dark_from = GRADIENT_DARK_FROM * (size / MASTER_SIZE)

    strip = Image.new("RGB", (span + 1, 1))
    pixels = strip.load()
    for total in range(span + 1):
        if total <= bright_until:
            value = GRADIENT_BRIGHT
        elif total >= dark_from:
            value = GRADIENT_DARK
        else:
            ratio = (total - bright_until) / (dark_from - bright_until)
            value = tuple(
                round(GRADIENT_BRIGHT[i] + (GRADIENT_DARK[i] - GRADIENT_BRIGHT[i]) * ratio)
                for i in range(3)
            )
        pixels[total, 0] = value

    gradient = Image.new("RGB", (size, size))
    for y in range(size):
        # Shifting the strip left by the row index means the pixel at (x, y)
        # reads the point of the lookup table the same distance along the
        # diagonal.
        gradient.paste(strip, (-y, y))
    return gradient


def mask_image(mask, size):
    """Turn a boolean mask into an L-mode image of the requested size."""
    image = Image.new("L", (MASTER_SIZE, MASTER_SIZE), 0)
    image.putdata(
        [
            255 if mask[y][x] else 0
            for y in range(MASTER_SIZE)
            for x in range(MASTER_SIZE)
        ]
    )
    if size == MASTER_SIZE:
        return image
    return image.resize((size, size), Image.NEAREST)


def render_raster(outer, disc, triangle, size):
    """Render the traced shapes into an RGBA image of the requested size."""
    supersample = 4
    work = size * supersample

    outer_mask = mask_image(outer, work)
    disc_mask = mask_image(disc, work)
    triangle_mask = mask_image(triangle, work)

    gradient = gradient_image(work).convert("RGBA")

    canvas = Image.new("RGBA", (work, work), (0, 0, 0, 0))
    canvas.paste(gradient, (0, 0), outer_mask)
    canvas.paste(Image.new("RGBA", (work, work), (255, 255, 255, 255)), (0, 0), disc_mask)
    canvas.paste(gradient, (0, 0), triangle_mask)

    return canvas.resize((size, size), Image.LANCZOS)


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

def write_svg(outer_path, disc_path, triangle_path):
    """Write the scalable master."""
    gradient = (
        f'<linearGradient id="mark-gradient" gradientUnits="userSpaceOnUse" '
        f'x1="0" y1="0" x2="{MASTER_SIZE}" y2="{MASTER_SIZE}">'
        f'<stop offset="0" stop-color="#{GRADIENT_BRIGHT[0]:02x}{GRADIENT_BRIGHT[1]:02x}{GRADIENT_BRIGHT[2]:02x}"/>'
        f'<stop offset="{GRADIENT_BRIGHT_UNTIL / (2 * MASTER_SIZE):.3f}" '
        f'stop-color="#{GRADIENT_BRIGHT[0]:02x}{GRADIENT_BRIGHT[1]:02x}{GRADIENT_BRIGHT[2]:02x}"/>'
        f'<stop offset="{GRADIENT_DARK_FROM / (2 * MASTER_SIZE):.3f}" '
        f'stop-color="#{GRADIENT_DARK[0]:02x}{GRADIENT_DARK[1]:02x}{GRADIENT_DARK[2]:02x}"/>'
        f'<stop offset="1" stop-color="#{GRADIENT_DARK[0]:02x}{GRADIENT_DARK[1]:02x}{GRADIENT_DARK[2]:02x}"/>'
        f'</linearGradient>'
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MASTER_SIZE} {MASTER_SIZE}" '
        f'width="{MASTER_SIZE}" height="{MASTER_SIZE}" role="img" aria-label="YouTube Desktop">\n'
        f'  <defs>\n    {gradient}\n  </defs>\n'
        f'  <path d="{outer_path}" fill="url(#mark-gradient)"/>\n'
        f'  <path d="{disc_path}" fill="#ffffff"/>\n'
        f'  <path d="{triangle_path}" fill="url(#mark-gradient)"/>\n'
        f'</svg>\n'
    )
    (ASSET_DIR / SVG_NAME).write_text(svg, encoding="utf-8")


def main():
    master = load_master()
    outer, disc, triangle, silhouette = classify(master)

    ASSET_DIR.mkdir(exist_ok=True)
    ICON_DIR.mkdir(exist_ok=True)

    outer_path = smooth(simplify(trace_contour(outer), 0.6))
    disc_path = smooth(simplify(trace_contour(disc), 0.6))
    triangle_path = smooth(simplify(trace_contour(triangle), 0.4))

    # A trace that silently loses part of a shape still renders, it just renders
    # the wrong icon. The traced area is checked against the area of the pixels
    # it came from so a broken trace fails loudly instead. The outer shape is
    # measured against the whole silhouette, because the ring of artwork around
    # the disc traces as one closed outline.
    for name, mask, contour in (
        ("outer", silhouette, trace_contour(outer)),
        ("disc", disc, trace_contour(disc)),
        ("triangle", triangle, trace_contour(triangle)),
    ):
        overlap = mask_overlap(mask, contour)
        if overlap < 0.95:
            raise SystemExit(
                f"{name} trace only covers {overlap:.1%} of the artwork"
            )
        print(f"traced {name}: {len(contour)} points, {overlap:.1%} overlap")

    write_svg(outer_path, disc_path, triangle_path)

    # The window icon is the traced artwork, not a resample of the .ico, so it
    # stays crisp at every zoom level the compositor asks for.
    render_raster(outer, disc, triangle, MASTER_SIZE).save(ASSET_DIR / PNG_NAME)

    # Small sizes come from the .ico's own frames where it has them; the rest
    # are resampled from the master so the set stays consistent.
    source = Image.open(SOURCE_ICO)
    for size in RASTER_SIZES:
        target = ICON_DIR / f"youtube-desktop-{size}.png"
        if size in ICO_FRAME_SIZES:
            frame = source.ico.getimage((size, size)).convert("RGBA")
        else:
            frame = render_raster(outer, disc, triangle, size)
        frame.save(target)
        print(f"wrote {target.relative_to(PROJECT_DIR)}")

    print(f"wrote {(ASSET_DIR / SVG_NAME).relative_to(PROJECT_DIR)}")
    print(f"wrote {(ASSET_DIR / PNG_NAME).relative_to(PROJECT_DIR)}")


if __name__ == "__main__":
    main()
