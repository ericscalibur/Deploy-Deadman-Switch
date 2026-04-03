import struct, zlib

def png_chunk(name, data):
    c = zlib.crc32(name + data) & 0xffffffff
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)

w, h = 256, 256
raw = b''.join(b'\x00' + bytes([100, 149, 237] * w) for _ in range(h))
compressed = zlib.compress(raw)

with open('build/icon.png', 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
    f.write(png_chunk(b'IDAT', compressed))
    f.write(png_chunk(b'IEND', b''))
print('icon.png created')
