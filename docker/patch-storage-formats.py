"""Apply the pinned fork's core-format compatibility fix inside the Linux image."""
from pathlib import Path


def patch(root):
    specifications = [
        ('TurquinTexture.js', 'RedFormat', 'RGBAFormat', 2),
        ('nodes/material.wgsl.js', 'texture_storage_3d<r16float, write>', 'texture_storage_3d<rgba16float, write>', 1),
    ]
    pending = []
    for name, old, new, count in specifications:
        path = root / name
        source = path.read_text()
        if source.count(old) != count:
            raise RuntimeError(f'Pinned storage-format patch no longer matches {name}; review the updated fork')
        pending.append((path, source.replace(old, new)))
    for path, source in pending:
        path.write_text(source)


if __name__ == '__main__':
    patch(Path(__file__).resolve().parents[1] / 'submodules/three-gpu-pathtracer/src/webgpu')
