#!/usr/bin/env python3
"""Run the fidelity CLI as one CPU-only DockerGrid task; describe needs only stdlib."""
import json
import mimetypes
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
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
                "samples": {"type": "integer", "minimum": 1, "maximum": 4096, "default": 4},
                "renderers": {"type": "string", "enum": ["all", *RENDERERS], "default": "all"},
                "width": {"type": "integer", "minimum": 16, "maximum": 1024},
                "height": {"type": "integer", "minimum": 16, "maximum": 1024},
            },
        },
        "outputHints": [
            {"role": "primary", "mimeType": "image/avif", "description": "WebGPU render"},
            {"role": "reference", "mimeType": "image/avif", "description": "WebGL or Blender reference"},
            {"role": "metrics", "mimeType": "application/json", "description": "Fidelity comparison metrics"},
            {"role": "delta", "mimeType": "image/webp", "description": "Comparison difference images"},
            {"role": "archive", "mimeType": "application/gzip", "description": "Complete results directory"},
        ],
        "gpu": "none",
    }


def integer(params, name, default, minimum, maximum):
    value = params.get(name, default)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
    return value


def parameters(params, root):
    if not isinstance(params, dict) or set(params) - {"scene", "samples", "renderers", "width", "height"}:
        raise ValueError("Unexpected task parameters")
    scene = params.get("scene", "gi-basic")
    if scene not in scene_names(root):
        raise ValueError("Scene is not available in this image")
    # A registry ID must identify exactly one scene, never a CLI glob or filesystem traversal.
    if not isinstance(scene, str) or any(character in scene for character in "/*?[]\\") or scene in (".", ".."):
        raise ValueError("Scene name must identify one scene")
    selection = params.get("renderers", "all")
    if selection not in ("all", *RENDERERS):
        raise ValueError("Unsupported renderer selection")
    selected = RENDERERS if selection == "all" else (selection,)
    samples = integer(params, "samples", 4, 1, 4096)
    dimensions = {name: integer(params, name, None, 16, 1024) for name in ("width", "height") if name in params}
    return scene, selected, samples, dimensions


def require_output(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError(f"Missing or empty required output: {path.name}")


def artifact_type(path):
    if path.name == "webgpu-new.avif":
        return "image/avif", "primary"
    if path.suffix == ".avif":
        return "image/avif", "reference"
    if path.name.endswith(".metrics.json"):
        return "application/json", "metrics"
    if path.name.endswith(".delta.webp"):
        return "image/webp", "delta"
    if path.suffix == ".json":
        return "application/json", "configuration" if path.name == "fidelity.json" else "metadata"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream", None


def run_task(farm, root):
    scene, selected, samples, dimensions = parameters(farm.params, root)
    with tempfile.TemporaryDirectory(prefix="dockergrid-fidelity-") as directory:
        results = Path(directory) / "results"
        results.mkdir()
        shutil.copyfile(root / "results" / "fidelity.json", results / "fidelity.json")
        command = [
            "node", str(root / "packages" / "cli" / "dist" / "bin.js"), "render",
            "--scenes", scene, "--renderers", ",".join(selected),
            "--samples", str(samples), "--min-samples", "1", "--noise-threshold", "0",
            "--cycles-noise-threshold", "0", "--blender-device", "cpu", "--output", str(results),
        ]
        for name, value in dimensions.items():
            command.extend([f"--{name}", str(value)])
        # Default subprocess stdio is inherited: Cloud Logging captures every renderer's logs.
        subprocess.run(command, cwd=root, check=True)
        beauty = results / scene / "beauty"
        for renderer in selected:
            require_output(beauty / f"{renderer}.avif")
        if len(selected) == len(RENDERERS):
            subprocess.run([str(root / "node_modules" / ".bin" / "fidelity-kit"), "process", str(results)], cwd=root, check=True)
            config = json.loads((results / "fidelity.json").read_text())
            references = [item["id"] for item in config["renderers"] if item.get("reference") and item["id"] in selected]
            if not references:
                raise RuntimeError("Fidelity configuration declares no selected reference renderers")
            for reference in references:
                for renderer in selected:
                    if renderer != reference:
                        for suffix in ("metrics.json", "delta.webp"):
                            require_output(beauty / f"{renderer}.vs-{reference}.{suffix}")
        artifacts = []
        for path in sorted(results.rglob("*")):
            if path.is_symlink():
                raise RuntimeError("Output symlinks are not allowed")
            if path.is_file():
                artifacts.append(path)
        archive = Path(directory) / "outputs.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for path in artifacts:
                bundle.add(path, arcname=str(path.relative_to(results)), recursive=False)
        for path in artifacts:
            mime_type, role = artifact_type(path)
            farm.output(path, mime_type, role)
        farm.output(archive, "application/gzip", "archive")


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
