#!/usr/bin/env python3
"""Run the fidelity CLI as one CPU-only DockerGrid task; describe needs only stdlib."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from farm import Farm

ROOT = Path(__file__).resolve().parent.parent
RENDERERS = ("webgpu-new", "webgl-legacy", "blender")


def scene_names(root=ROOT):
    names = json.loads((root / "docker" / "scenes.json").read_text())
    if not isinstance(names, list) or not names or any(not isinstance(name, str) or not name for name in names):
        raise ValueError("docker/scenes.json must be a non-empty array of scene names")
    if "gi-basic" not in names:
        raise ValueError("Scene catalog must include the default gi-basic scene")
    return list(dict.fromkeys(names))


def describe(root=ROOT):
    return {
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "scene": {"type": "string", "enum": scene_names(root), "default": "gi-basic"},
                "renderer": {"type": "string", "enum": list(RENDERERS), "default": "webgpu-new"},
                "samples": {"type": "integer", "minimum": 1, "maximum": 4096, "default": 4096},
                "minSamples": {"type": "integer", "minimum": 0, "maximum": 4096, "default": 128},
                "noiseThreshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.005},
                "cyclesNoiseThreshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.005},
            },
        },
        "outputHints": [
            {"role": "primary", "mimeType": "image/avif", "description": "Selected scene and renderer at native dimensions"},
        ],
        "gpu": "none",
    }


def integer(params, name, default, minimum, maximum):
    value = params.get(name, default)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
    return value


def threshold(params, name):
    value = params.get(name, 0.005)
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be a finite number from 0 to 1")
    return value


def parameters(params, root):
    allowed = {"scene", "renderer", "samples", "minSamples", "noiseThreshold", "cyclesNoiseThreshold"}
    if not isinstance(params, dict) or set(params) - allowed:
        raise ValueError("Unexpected task parameters")
    scene = params.get("scene", "gi-basic")
    if scene not in scene_names(root):
        raise ValueError("Scene is not available in this image")
    # A registry ID must identify exactly one scene, never a CLI glob or filesystem traversal.
    if not isinstance(scene, str) or any(character in scene for character in "/,*?[]\\") or scene in (".", ".."):
        raise ValueError("Scene name must identify one scene")
    renderer = params.get("renderer", "webgpu-new")
    if renderer not in RENDERERS:
        raise ValueError("Unsupported renderer selection")
    sampling = {
        "samples": integer(params, "samples", 4096, 1, 4096),
        "min-samples": integer(params, "minSamples", 128, 0, 4096),
        "noise-threshold": threshold(params, "noiseThreshold"),
        "cycles-noise-threshold": threshold(params, "cyclesNoiseThreshold"),
    }
    return scene, renderer, sampling


def require_output(path, results):
    if path.is_symlink() or not path.resolve().is_relative_to(results.resolve()) or not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError(f"Missing or empty required output: {path.name}")


def run_task(farm, root):
    scene, renderer, sampling = parameters(farm.params, root)
    context = f"scene={scene} renderer={renderer}"
    print(f"DockerGrid render starting: {context}; native scene dimensions; sampling={sampling}", flush=True)
    if renderer == "blender":
        # Cloud Run loads native libraries lazily. Warm them before the adapter's
        # five-second version probe, only when this task actually uses Blender.
        subprocess.run([os.environ.get("BLENDER_EXECUTABLE", "blender"), "--version"], cwd=root, check=True, timeout=60)
    with tempfile.TemporaryDirectory(prefix="dockergrid-fidelity-") as directory:
        results = Path(directory) / "results"
        results.mkdir()
        command = [
            "node", str(root / "packages" / "cli" / "dist" / "bin.js"), "render",
            "--scenes", scene, "--renderers", renderer,
            "--blender-device", "cpu", "--output", str(results),
        ]
        for name, value in sampling.items():
            command.extend([f"--{name}", str(value)])
        # The CLI validates black frames; inherited stdio sends renderer logs to Cloud Logging.
        subprocess.run(command, cwd=root, check=True)
        image = results / scene / "beauty" / f"{renderer}.avif"
        require_output(image, results)
        # The farm uses the basename. Preserve scene and engine identity across batch downloads.
        output = Path(directory) / f"{scene}.{renderer}.avif"
        image.rename(output)
        print(f"DockerGrid uploading: {context}; output={output.name}; bytes={output.stat().st_size}", flush=True)
        farm.output(output, "image/avif", "primary")
        print(f"DockerGrid render completed: {context}", flush=True)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--describe"]:
        print(json.dumps(describe(ROOT)))
        return
    if argv:
        raise ValueError("Only --describe or default task mode is supported")
    farm = Farm()
    try:
        run_task(farm, ROOT)
        farm.complete()
    except Exception as error:
        try:
            farm.complete(error)
        except Exception:
            print("Could not report task failure to DockerGrid", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
