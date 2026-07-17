import os
from PIL import Image, ImageDraw

def draw_icon(size):
    # Create image with RGBA
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 1. Draw rounded background (or solid square for maskable icon compatibility)
    # Gradient background from #1a1030 to #2a1a4a
    # We will do a simple radial or linear gradient
    c1 = (26, 16, 48, 255)   # #1a1030
    c2 = (42, 26, 74, 255)   # #2a1a4a
    
    for y in range(size):
        # Linear gradient calculation
        r = int(c1[0] + (c2[0] - c1[0]) * (y / size))
        g = int(c1[1] + (c2[1] - c1[1]) * (y / size))
        b = int(c1[2] + (c2[2] - c1[2]) * (y / size))
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))
        
    # Draw border around the icon
    border_color = (212, 175, 55, 60) # Semi-transparent gold (#D4AF37)
    draw.rounded_rectangle([2, 2, size-3, size-3], radius=int(size * 0.22), outline=border_color, width=max(1, int(size * 0.015)))
    
    # 2. Draw overlapping speech bubbles in the center
    # Center coordinates
    cx, cy = size // 2, size // 2
    r_bubble = int(size * 0.16)
    
    # Left/Top bubble (Gold)
    gold_color = (212, 175, 55, 255)  # #D4AF37
    x1, y1 = cx - int(size * 0.18), cy - int(size * 0.12)
    # Draw circle
    draw.ellipse([x1 - r_bubble, y1 - r_bubble, x1 + r_bubble, y1 + r_bubble], fill=gold_color)
    # Draw speech bubble tail
    tail_pts_1 = [
        (x1, y1 + r_bubble - 2),
        (x1 - r_bubble, y1 + r_bubble + 5),
        (x1 - r_bubble // 2, y1 + r_bubble // 2)
    ]
    draw.polygon(tail_pts_1, fill=gold_color)
    
    # Right/Bottom bubble (Cyan)
    cyan_color = (0, 180, 219, 255)  # #00B4DB
    x2, y2 = cx + int(size * 0.12), cy + int(size * 0.12)
    # Draw circle
    draw.ellipse([x2 - r_bubble, y2 - r_bubble, x2 + r_bubble, y2 + r_bubble], fill=cyan_color)
    # Draw speech bubble tail
    tail_pts_2 = [
        (x2, y2 - r_bubble + 2),
        (x2 + r_bubble, y2 - r_bubble - 5),
        (x2 + r_bubble // 2, y2 - r_bubble // 2)
    ]
    draw.polygon(tail_pts_2, fill=cyan_color)
    
    # Save the file
    out_dir = os.path.join('c:\\Users\\user\\Downloads\\my-translator\\static')
    os.makedirs(out_dir, exist_ok=True)
    img.save(os.path.join(out_dir, f'icon-{size}.png'), 'PNG')
    print(f"Generated icon-{size}.png")

if __name__ == '__main__':
    draw_icon(192)
    draw_icon(512)
