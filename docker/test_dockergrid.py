"""Contract tests use no renderer, native extension, Docker, or cloud account."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dockergrid


class DockerGridTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "docker").mkdir()
        (self.root / "docker" / "scenes.json").write_text(json.dumps(["gi-basic", "gi-other"]))
        (self.root / "results").mkdir()
        (self.root / "results" / "fidelity.json").write_text(json.dumps({
            "renderers": [{"id": name, "reference": name != "webgpu-new"} for name in dockergrid.RENDERERS],
            "outputs": [{"id": "beauty"}],
        }))
        self.uploaded = []
        self.farm = Mock(params={})
        self.farm.output.side_effect = self.collect_output

    def collect_output(self, path, mime_type, role):
        self.uploaded.append((path.name, mime_type, role, path.read_bytes()))
        if role == "archive":
            with tarfile.open(fileobj=io.BytesIO(path.read_bytes()), mode="r:gz") as archive:
                self.archive_names = archive.getnames()

    def render_outputs(self, command, **kwargs):
        if command[-1] == "--version":
            return subprocess.CompletedProcess(command, 0)
        if command[0] == "node":
            root = Path(command[command.index("--output") + 1])
            scene = command[command.index("--scenes") + 1]
            beauty = root / scene / "beauty"
            beauty.mkdir(parents=True)
            for renderer in command[command.index("--renderers") + 1].split(","):
                (beauty / f"{renderer}.avif").write_bytes(b"rendered image")
        else:
            root = Path(command[-1])
            beauty = root / "gi-basic" / "beauty"
            for reference in ("webgl-legacy", "blender"):
                for renderer in dockergrid.RENDERERS:
                    if renderer != reference:
                        stem = f"{renderer}.vs-{reference}"
                        (beauty / f"{stem}.metrics.json").write_text('{"psnr": 40}')
                        (beauty / f"{stem}.delta.webp").write_bytes(b"delta image")
                        (beauty / f"{stem}.delta.webp.json").write_text('{"version": 1}')
            (root / "index.json").write_text('{"metrics": {}}')
        return subprocess.CompletedProcess(command, 0)

    def main(self, process):
        with patch.object(dockergrid, "ROOT", self.root), patch.object(dockergrid, "Farm", return_value=self.farm), patch.object(dockergrid.subprocess, "run", side_effect=process) as run:
            dockergrid.main([])
            return run

    def test_describe_never_bootstraps_or_loads_renderers(self):
        output = io.StringIO()
        with patch.object(dockergrid, "ROOT", self.root), patch.object(dockergrid, "Farm") as farm, patch.object(dockergrid.subprocess, "run") as run, contextlib.redirect_stdout(output):
            dockergrid.main(["--describe"])
        description = json.loads(output.getvalue())
        properties = description["inputSchema"]["properties"]
        self.assertEqual(properties["samples"], {"type": "integer", "minimum": 1, "maximum": 4096, "default": 4})
        self.assertEqual(properties["scene"]["enum"], ["gi-basic", "gi-other"])
        self.assertEqual(properties["renderers"]["default"], "all")
        self.assertNotIn("default", properties["width"])
        self.assertEqual(description["gpu"], "none")
        farm.assert_not_called()
        run.assert_not_called()

    def test_catalog_is_required_instead_of_advertising_unavailable_scenes(self):
        (self.root / "docker" / "scenes.json").unlink()
        with self.assertRaises(FileNotFoundError):
            dockergrid.describe(self.root)

    def test_all_runs_exact_four_samples_and_uploads_every_file_with_archive(self):
        run = self.main(self.render_outputs)
        self.assertEqual(run.call_count, 3)
        self.assertEqual(run.call_args_list[0].args[0][-1], "--version")
        self.assertEqual(run.call_args_list[0].kwargs, {"cwd": self.root, "check": True, "timeout": 60})
        command = run.call_args_list[1].args[0]
        for flag, expected in (("--samples", "4"), ("--min-samples", "1"), ("--noise-threshold", "0"), ("--cycles-noise-threshold", "0"), ("--blender-device", "cpu")):
            self.assertEqual(command[command.index(flag) + 1], expected)
        self.assertNotIn("--width", command)
        self.assertNotIn("--height", command)
        self.assertEqual(run.call_args_list[1].kwargs, {"cwd": self.root, "check": True})
        self.assertEqual(run.call_args_list[2].args[0][1], "process")
        roles = [item[2] for item in self.uploaded]
        self.assertEqual(roles.count("primary"), 1)
        self.assertEqual(roles.count("reference"), 2)
        self.assertEqual(roles.count("metrics"), 4)
        self.assertEqual(roles.count("delta"), 4)
        self.assertEqual(roles.count("archive"), 1)
        self.assertEqual(len(self.archive_names), len(self.uploaded) - 1)
        self.assertIn("gi-basic/beauty/webgpu-new.avif", self.archive_names)
        self.assertIn("fidelity.json", self.archive_names)
        self.assertTrue(all(not name.startswith("/") for name in self.archive_names))
        self.assertTrue(all(mime == "application/json" for name, mime, _, _ in self.uploaded if name.endswith(".json")))
        self.farm.complete.assert_called_once_with()

    def test_each_single_renderer_forwards_resolution_and_skips_metrics(self):
        for renderer in dockergrid.RENDERERS:
            with self.subTest(renderer=renderer):
                self.farm.reset_mock()
                self.uploaded.clear()
                self.farm.params = {"renderers": renderer, "samples": 12, "width": 64, "height": 96}
                run = self.main(self.render_outputs)
                self.assertEqual(run.call_count, 2 if renderer == "blender" else 1)
                command = run.call_args.args[0]
                for flag, expected in (("--renderers", renderer), ("--samples", "12"), ("--width", "64"), ("--height", "96")):
                    self.assertEqual(command[command.index(flag) + 1], expected)
                self.assertEqual(len(self.uploaded), 3)
                self.farm.complete.assert_called_once_with()

    def test_subprocess_failure_reports_failure_and_reraises(self):
        error = subprocess.CalledProcessError(2, ["node", "render"])
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.main(error)
        self.assertIs(caught.exception, error)
        self.farm.complete.assert_called_once_with(error)
        self.farm.output.assert_not_called()

    def test_blender_cold_start_timeout_fails_before_rendering(self):
        error = subprocess.TimeoutExpired(["blender", "--version"], 60)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.main(error)
        self.farm.complete.assert_called_once_with(error)
        self.farm.output.assert_not_called()

    def test_success_exit_without_selected_images_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, "Missing or empty required output") as caught:
            self.main(lambda *_args, **_kwargs: None)
        self.farm.complete.assert_called_once_with(caught.exception)
        self.farm.output.assert_not_called()

    def test_partial_renderer_output_is_failure(self):
        def partial(command, **kwargs):
            self.render_outputs(command, **kwargs)
            if command[-1] == "--version":
                return
            results = Path(command[command.index("--output") + 1])
            (results / "gi-basic" / "beauty" / "blender.avif").unlink()
        with self.assertRaisesRegex(RuntimeError, "blender.avif"):
            self.main(partial)
        self.farm.output.assert_not_called()

    def test_missing_comparison_artifacts_is_failure(self):
        def images_only(command, **kwargs):
            if command[0] == "node":
                return self.render_outputs(command, **kwargs)
        with self.assertRaisesRegex(RuntimeError, "metrics.json") as caught:
            self.main(images_only)
        self.farm.complete.assert_called_once_with(caught.exception)
        self.farm.output.assert_not_called()

    def test_processing_failure_reports_failure(self):
        def failed_metrics(command, **kwargs):
            if command[0] != "node" and command[-1] != "--version":
                raise subprocess.CalledProcessError(1, command)
            return self.render_outputs(command, **kwargs)
        with self.assertRaises(subprocess.CalledProcessError):
            self.main(failed_metrics)
        self.farm.complete.assert_called_once()
        self.farm.output.assert_not_called()

    def test_upload_failure_never_reports_success(self):
        error = RuntimeError("storage unavailable")
        self.farm.output.side_effect = error
        with self.assertRaises(RuntimeError) as caught:
            self.main(self.render_outputs)
        self.assertIs(caught.exception, error)
        self.farm.complete.assert_called_once_with(error)

    def test_failure_reporting_does_not_mask_original_exception(self):
        error = RuntimeError("renderer failure")
        self.farm.complete.side_effect = RuntimeError("API unavailable")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(RuntimeError) as caught:
            self.main(error)
        self.assertIs(caught.exception, error)

    def test_invalid_parameters_fail_before_rendering(self):
        for params in ({"samples": 0}, {"samples": 4097}, {"samples": True}, {"samples": 4.5}, {"scene": "*"}, {"renderers": "gpu"}, {"width": 15}, {"height": 1025}, {"extra": "not allowed"}):
            with self.subTest(params=params):
                self.farm.reset_mock()
                self.farm.params = params
                with self.assertRaises(ValueError):
                    self.main(lambda *_args, **_kwargs: self.fail("render must not run"))
                self.farm.complete.assert_called_once()
                self.farm.output.assert_not_called()

    def test_output_symlink_cannot_leak_other_files(self):
        def symlink(command, **kwargs):
            self.render_outputs(command, **kwargs)
            if command[0] != "node" and command[-1] != "--version":
                results = Path(command[-1])
                secret = self.root / "unrelated-file"
                secret.write_text("do not upload")
                (results / "external.txt").symlink_to(secret)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            self.main(symlink)
        self.farm.output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
