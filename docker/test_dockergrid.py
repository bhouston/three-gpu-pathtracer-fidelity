"""Contract tests use no renderer, native extension, Docker, or cloud account."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
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
        # No committed results or fidelity configuration is needed for a single render.
        self.uploaded = []
        self.farm = Mock(params={})
        self.farm.output.side_effect = self.collect_output

    def collect_output(self, path, mime_type, role):
        self.uploaded.append((path.name, mime_type, role, path.read_bytes()))

    def render_outputs(self, command, **kwargs):
        if command[-1] == "--version":
            return subprocess.CompletedProcess(command, 0)
        self.assertEqual(command[0], "node", "Only the render CLI may run")
        results = Path(command[command.index("--output") + 1])
        scene = command[command.index("--scenes") + 1]
        renderer = command[command.index("--renderers") + 1]
        beauty = results / scene / "beauty"
        beauty.mkdir(parents=True)
        (beauty / f"{renderer}.avif").write_bytes(b"rendered image")
        # CLI sidecars and unrelated files must never become farm outputs.
        (beauty / f"{renderer}.avif.json").write_text('{"samples": 128}')
        (results / "extra.json").write_text('{}')
        return subprocess.CompletedProcess(command, 0)

    def main(self, process):
        with patch.object(dockergrid, "ROOT", self.root), patch.object(dockergrid, "Farm", return_value=self.farm), patch.object(dockergrid.subprocess, "run", side_effect=process) as run, contextlib.redirect_stdout(io.StringIO()):
            dockergrid.main([])
            return run

    def test_describe_never_bootstraps_or_loads_renderers(self):
        output = io.StringIO()
        with patch.object(dockergrid, "ROOT", self.root), patch.object(dockergrid, "Farm") as farm, patch.object(dockergrid.subprocess, "run") as run, contextlib.redirect_stdout(output):
            dockergrid.main(["--describe"])
        description = json.loads(output.getvalue())
        properties = description["inputSchema"]["properties"]
        self.assertEqual(set(properties), {"scene", "renderer", "samples", "minSamples", "noiseThreshold", "cyclesNoiseThreshold"})
        self.assertEqual(properties["scene"]["enum"], ["gi-basic", "gi-other"])
        self.assertEqual(properties["renderer"]["enum"], list(dockergrid.RENDERERS))
        self.assertEqual(properties["renderer"]["default"], "webgpu-new")
        for key, default in (("samples", 4096), ("minSamples", 128), ("noiseThreshold", 0.005), ("cyclesNoiseThreshold", 0.005)):
            self.assertEqual(properties[key]["default"], default)
        self.assertFalse(description["inputSchema"]["additionalProperties"])
        self.assertEqual(description["gpu"], "none")
        self.assertEqual([(hint["role"], hint["mimeType"]) for hint in description["outputHints"]], [("primary", "image/avif")])
        farm.assert_not_called()
        run.assert_not_called()

    def test_catalog_is_required_instead_of_advertising_unavailable_scenes(self):
        (self.root / "docker" / "scenes.json").unlink()
        with self.assertRaises(FileNotFoundError):
            dockergrid.describe(self.root)

    def test_default_matches_cli_sampling_and_uploads_one_primary_image(self):
        run = self.main(self.render_outputs)
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        for flag, expected in (("--scenes", "gi-basic"), ("--renderers", "webgpu-new"), ("--samples", "4096"), ("--min-samples", "128"), ("--noise-threshold", "0.005"), ("--cycles-noise-threshold", "0.005"), ("--blender-device", "cpu")):
            self.assertEqual(command[command.index(flag) + 1], expected)
        self.assertNotIn("--width", command)
        self.assertNotIn("--height", command)
        self.assertEqual(run.call_args.kwargs, {"cwd": self.root, "check": True})
        self.assertEqual(self.uploaded, [("gi-basic.webgpu-new.avif", "image/avif", "primary", b"rendered image")])
        self.farm.complete.assert_called_once_with()

    def test_each_renderer_and_scene_uploads_one_primary_with_sampling_overrides(self):
        for renderer in dockergrid.RENDERERS:
            with self.subTest(renderer=renderer):
                self.farm.reset_mock()
                self.uploaded.clear()
                self.farm.params = {"scene": "gi-other", "renderer": renderer, "samples": 12, "minSamples": 0, "noiseThreshold": 0, "cyclesNoiseThreshold": 0.01}
                run = self.main(self.render_outputs)
                self.assertEqual(run.call_count, 2 if renderer == "blender" else 1)
                if renderer == "blender":
                    self.assertEqual(run.call_args_list[0].args[0][-1], "--version")
                    self.assertEqual(run.call_args_list[0].kwargs, {"cwd": self.root, "check": True, "timeout": 60})
                command = run.call_args.args[0]
                for flag, expected in (("--scenes", "gi-other"), ("--renderers", renderer), ("--samples", "12"), ("--min-samples", "0"), ("--noise-threshold", "0"), ("--cycles-noise-threshold", "0.01")):
                    self.assertEqual(command[command.index(flag) + 1], expected)
                self.assertEqual(self.uploaded, [(f"gi-other.{renderer}.avif", "image/avif", "primary", b"rendered image")])
                self.farm.complete.assert_called_once_with()

    def test_subprocess_failure_including_black_frame_rejection_reports_failure(self):
        error = subprocess.CalledProcessError(1, ["node", "render"])
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.main(error)
        self.assertIs(caught.exception, error)
        self.farm.complete.assert_called_once_with(error)
        self.farm.output.assert_not_called()

    def test_blender_cold_start_timeout_fails_before_rendering(self):
        self.farm.params = {"renderer": "blender"}
        error = subprocess.TimeoutExpired(["blender", "--version"], 60)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.main(error)
        self.farm.complete.assert_called_once_with(error)
        self.farm.output.assert_not_called()

    def test_missing_or_empty_selected_image_fails(self):
        for empty in (False, True):
            with self.subTest(empty=empty):
                self.farm.reset_mock()
                def missing(command, **kwargs):
                    if empty:
                        self.render_outputs(command, **kwargs)
                        results = Path(command[command.index("--output") + 1])
                        (results / "gi-basic" / "beauty" / "webgpu-new.avif").write_bytes(b"")
                with self.assertRaisesRegex(RuntimeError, "Missing or empty required output") as caught:
                    self.main(missing)
                self.farm.complete.assert_called_once_with(caught.exception)
                self.farm.output.assert_not_called()

    def test_output_symlink_cannot_leak_other_files(self):
        def symlink(command, **kwargs):
            self.render_outputs(command, **kwargs)
            results = Path(command[command.index("--output") + 1])
            image = results / "gi-basic" / "beauty" / "webgpu-new.avif"
            image.unlink()
            secret = self.root / "unrelated-file"
            secret.write_text("do not upload")
            image.symlink_to(secret)
        with self.assertRaisesRegex(RuntimeError, "Missing or empty required output"):
            self.main(symlink)
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
        invalid = ({"samples": 0}, {"samples": 4097}, {"samples": True}, {"samples": 4.5}, {"minSamples": -1}, {"minSamples": True}, {"minSamples": 4097}, {"noiseThreshold": -0.01}, {"noiseThreshold": 1.1}, {"noiseThreshold": float("nan")}, {"cyclesNoiseThreshold": float("inf")}, {"cyclesNoiseThreshold": True}, {"scene": "*"}, {"scene": ["gi-basic"]}, {"renderer": "all"}, {"renderer": "webgpu-new,blender"}, {"renderers": "blender"}, {"width": 64}, {"height": 64}, {"extra": "not allowed"})
        for params in invalid:
            with self.subTest(params=params):
                self.farm.reset_mock()
                self.farm.params = params
                with self.assertRaises(ValueError):
                    self.main(lambda *_args, **_kwargs: self.fail("render must not run"))
                self.farm.complete.assert_called_once()
                self.farm.output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
