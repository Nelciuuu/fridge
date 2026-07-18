"""One-off icon generator for the Lodówka PWA. Run: python scripts/gen_icons.py"""
from PIL import Image, ImageDraw

BG = (30, 136, 145)      # teal
FRIDGE = (255, 255, 255)
ACCENT = (255, 176, 32)  # warm accent for the handle/light

def draw_fridge(size, padding_ratio=0.16):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)

    pad = int(size * padding_ratio)
    body = [pad, int(size * 0.10), size - pad, size - int(size * 0.10)]
    body_r = int(size * 0.08)
    d.rounded_rectangle(body, radius=body_r, fill=FRIDGE)

    # freezer/fridge divider line
    divider_y = body[1] + int((body[3] - body[1]) * 0.32)
    d.rectangle([body[0] + int(size*0.02), divider_y, body[2] - int(size*0.02), divider_y + max(2, int(size*0.012))], fill=BG)

    # door handles
    handle_w = max(3, int(size * 0.025))
    handle_x = body[0] + int(size * 0.10)
    d.rounded_rectangle([handle_x, body[1] + int(size*0.06), handle_x + handle_w, divider_y - int(size*0.05)], radius=handle_w, fill=ACCENT)
    d.rounded_rectangle([handle_x, divider_y + int(size*0.06), handle_x + handle_w, body[3] - int(size*0.06)], radius=handle_w, fill=ACCENT)

    return img

for size, name in [(192, "icons/icon-192.png"), (512, "icons/icon-512.png")]:
    draw_fridge(size).save(name)

# maskable icon needs more safe-area padding (~20%) since OS may crop to a circle
draw_fridge(512, padding_ratio=0.24).save("icons/maskable-512.png")

# apple-touch-icon: iOS adds its own rounding, so no radius / transparency
apple = Image.new("RGB", (180, 180), BG)
tmp = draw_fridge(180, padding_ratio=0.18)
apple.paste(tmp, (0, 0), tmp)
apple.save("icons/apple-touch-icon.png")

print("icons generated")
