#!/usr/bin/env python3
"""Restore single-render DockerGrid AVIFs to the fidelity results hierarchy."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
RENDERERS = ("webgpu-new", "webgl-legacy", "blender")
SCENE_NAME = re.compile(r"[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*")


def nonnegative_integer(value, label):
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a nonnegative integer")
    return value


def plan(job, listing):
    if not isinstance(job, dict) or not isinstance(job.get("id"), str) or not job["id"]:
        raise ValueError("Job export must contain an id")
    tasks = job.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("Job export must contain a nonempty tasks array")
    pairs = []
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            raise ValueError(f"Task {index} must be an object")
        scene = task.get("scene", "gi-basic")
        renderer = task.get("renderer", "webgpu-new")
        if not isinstance(scene, str) or not SCENE_NAME.fullmatch(scene) or renderer not in RENDERERS:
            raise ValueError(f"Task {index} must select one safe scene name and supported renderer")
        pairs.append((scene, renderer))
    if len(set(pairs)) != len(pairs):
        raise ValueError("Job contains duplicate scene/renderer pairs; collect separate render batches separately")
    if not isinstance(listing, dict) or not isinstance(listing.get("outputs"), list):
        raise ValueError("Outputs export must contain an outputs array")
    selected = {}
    seen = set()
    for output in listing["outputs"]:
        if not isinstance(output, dict) or output.get("jobId") != job["id"]:
            raise ValueError("Output belongs to another job or is not an object")
        index = nonnegative_integer(output.get("taskIndex"), "Output taskIndex")
        attempt = nonnegative_integer(output.get("attempt"), "Output attempt")
        if index >= len(pairs):
            raise ValueError("Output taskIndex is outside the job")
        scene, renderer = pairs[index]
        if output.get("name") != f"{scene}.{renderer}.avif" or output.get("mimeType") != "image/avif":
            raise ValueError(f"Output for task {index} has an unexpected filename or MIME type")
        if nonnegative_integer(output.get("bytes"), "Output bytes") == 0:
            raise ValueError(f"Output for task {index} is empty")
        url = output.get("downloadUrl")
        if not isinstance(url, str) or urlparse(url).scheme != "https" or not urlparse(url).netloc:
            raise ValueError(f"Output for task {index} needs an HTTPS downloadUrl; refresh the outputs export")
        if (index, attempt) in seen:
            raise ValueError(f"Task {index} has multiple outputs for attempt {attempt}")
        seen.add((index, attempt))
        pair = (scene, renderer)
        if pair not in selected or attempt > selected[pair]["attempt"]:
            selected[pair] = output
    missing = [
        {"taskIndex": index, "scene": scene, "renderer": renderer}
        for index, (scene, renderer) in enumerate(pairs) if (scene, renderer) not in selected
    ]
    return selected, missing, len(pairs)


def download(output, destination, root, opener):
    if not destination.parent.resolve().is_relative_to(root):
        raise ValueError("Output directory contains a path escaping the selected results directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with opener(output["downloadUrl"], timeout=120) as response:
            mime_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if mime_type != "image/avif":
                raise ValueError("Download response MIME type is not image/avif")
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                temporary = Path(stream.name)
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > output["bytes"]:
                        raise ValueError("Downloaded bytes exceed output metadata")
                    stream.write(chunk)
            if count != output["bytes"]:
                raise ValueError("Downloaded bytes do not match output metadata")
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def collect(job, listing, directory, *, require_complete=False, workers=8, opener=urlopen, config=None):
    if type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("workers must be an integer from 1 to 8")
    selected, missing, expected = plan(job, listing)
    complete = not missing and job.get("status") == "succeeded"
    if require_complete and not complete:
        raise ValueError(f"Job is not complete: status={job.get('status')}, missing={len(missing)}/{expected}")
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Replace configuration atomically too; no comparison processing happens here.
    config = Path(config) if config is not None else ROOT / "results" / "fidelity.json"
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        shutil.copyfile(config, temporary)
        temporary.replace(root / "fidelity.json")
    finally:
        temporary.unlink(missing_ok=True)
    failures = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(download, output, root / scene / "beauty" / f"{renderer}.avif", root, opener): (scene, renderer)
            for (scene, renderer), output in selected.items()
        }
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as error:
                scene, renderer = futures[future]
                failures.append(f"{scene}/{renderer}: {error}")
    if failures:
        raise RuntimeError("Downloads failed; refresh outputs export if signed URLs expired: " + "; ".join(sorted(failures)))
    return {
        "jobId": job["id"], "jobStatus": job.get("status"), "complete": complete,
        "downloaded": len(selected), "expected": expected, "missing": missing,
        "outputDirectory": str(root),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=Path, help="farm jobs get JSON export")
    parser.add_argument("--outputs", required=True, type=Path, help="farm jobs outputs JSON export with fresh signed URLs")
    parser.add_argument("--output", required=True, type=Path, help="Results directory to create or update")
    parser.add_argument("--workers", type=int, default=8, help="Parallel downloads, 1–8 (default 8)")
    parser.add_argument("--require-complete", action="store_true", help="Reject incomplete jobs before writing results")
    args = parser.parse_args(argv)
    try:
        report = collect(json.loads(args.job.read_text()), json.loads(args.outputs.read_text()), args.output,
                         require_complete=args.require_complete, workers=args.workers)
    except (ValueError, RuntimeError, OSError) as error:
        print(f"Collection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    if not report["complete"]:
        print("Partial collection: do not process comparisons yet; refresh exports and collect again after completion.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
