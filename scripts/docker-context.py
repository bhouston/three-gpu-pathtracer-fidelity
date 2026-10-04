"""Create a source-only Docker build context with pinned, initialized submodules."""
import argparse
import json
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--include-model-assets', action='store_true', help='Include multi-gigabyte model submodules')
args = parser.parse_args()
code = ['three-gpu-pathtracer', 'fidelity-kit-blender', 'fidelity-kit-three-gpu-pathtracer']
assets = ['glTF-Sample-Assets', '3d-demo-data', 'ldraw-parts-library'] if args.include_model_assets else []

def tracked(directory):
    return subprocess.check_output(['git-dedup', '-C', str(directory), 'ls-files', '-z']).decode().split('\0')

args.output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(args.output, 'w:gz', dereference=True) as archive:
    archive.add(root / 'docker' / 'Dockerfile', arcname='Dockerfile')
    for name in tracked(root):
        if not name or name.startswith('submodules/') or (name.startswith('results/') and name not in ['results/fidelity.json', 'results/README.md']):
            continue
        path = root / name
        if path.is_file():
            archive.add(path, arcname=name, recursive=False)
    for module in code + assets:
        directory = root / 'submodules' / module
        if not (directory / '.git').exists():
            raise RuntimeError(f'Initialize submodule {module} before packaging')
        for name in tracked(directory):
            path = directory / name
            if name and path.is_file() and '.git' not in Path(name).parts:
                archive.add(path, arcname=f'submodules/{module}/{name}', recursive=False)
print(f'Created {args.output}: {args.output.stat().st_size:,} bytes')
