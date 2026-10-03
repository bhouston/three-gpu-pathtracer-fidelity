"""Collector contract tests inject HTTP responses; no cloud or native renderer needed."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("dockergrid-collect.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class Response(io.BytesIO):
    def __init__(self, data=b"avif", mime="image/avif"):
        super().__init__(data)
        self.headers = {"Content-Type": mime}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "fidelity.json"
        self.config.write_text('{"renderers": []}')
        self.destination = self.root / "collected"
        self.job = {"id": "job1", "status": "succeeded", "tasks": [
            {"scene": "gi-basic", "renderer": "webgpu-new"},
            {"scene": "gi-basic", "renderer": "blender"},
        ]}
        self.listing = {"outputs": [self.output(0), self.output(1)]}

    def output(self, index, attempt=0):
        task = self.job["tasks"][index]
        return {"jobId": "job1", "taskIndex": index, "attempt": attempt,
                "name": f"{task['scene']}.{task['renderer']}.avif", "mimeType": "image/avif",
                "bytes": 4, "downloadUrl": f"https://storage.example/{index}/{attempt}"}

    def collect(self, **kwargs):
        return collector.collect(self.job, self.listing, self.destination, config=self.config,
                                 opener=kwargs.pop("opener", lambda *_args, **_kwargs: Response()), **kwargs)

    def test_restores_layout_configuration_and_reports_complete(self):
        report = self.collect(require_complete=True)
        self.assertTrue(report["complete"])
        self.assertEqual((report["downloaded"], report["expected"], report["missing"]), (2, 2, []))
        self.assertEqual((self.destination / "fidelity.json").read_bytes(), self.config.read_bytes())
        self.assertEqual(sorted(str(path.relative_to(self.destination)) for path in self.destination.rglob("*") if path.is_file()),
                         ["fidelity.json", "gi-basic/beauty/blender.avif", "gi-basic/beauty/webgpu-new.avif"])

    def test_selects_highest_attempt_even_when_list_is_unordered(self):
        self.listing["outputs"] = [self.output(0, 2), self.output(0, 0), self.output(1, 1)]
        requested = []
        def opener(url, **kwargs):
            requested.append(url)
            return Response()
        self.collect(opener=opener)
        self.assertEqual(sorted(requested), ["https://storage.example/0/2", "https://storage.example/1/1"])

    def test_partial_collection_reports_missing_and_does_not_claim_completion(self):
        self.job["status"] = "running"
        self.listing["outputs"] = [self.output(0)]
        report = self.collect()
        self.assertFalse(report["complete"])
        self.assertEqual(report["downloaded"], 1)
        self.assertEqual(report["missing"], [{"taskIndex": 1, "scene": "gi-basic", "renderer": "blender"}])

    def test_require_complete_blocks_writes_for_missing_outputs_or_running_job(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                if missing:
                    self.listing["outputs"] = []
                else:
                    self.job["status"] = "running"
                with self.assertRaisesRegex(ValueError, "not complete"):
                    self.collect(require_complete=True)
                self.assertFalse(self.destination.exists())

    def test_rejects_invalid_output_metadata_before_any_download(self):
        invalid = ({"jobId": "other"}, {"taskIndex": -1}, {"taskIndex": True}, {"taskIndex": 2},
                   {"attempt": -1}, {"attempt": 0.5}, {"name": "../blender.avif"}, {"name": "gi-other.webgpu-new.avif"},
                   {"mimeType": "text/html"}, {"bytes": 0}, {"bytes": True}, {"bytes": 4.5},
                   {"downloadUrl": "http://storage.example/a"}, {"downloadUrl": None})
        for changes in invalid:
            with self.subTest(changes=changes):
                self.listing["outputs"] = [dict(self.output(0), **changes)]
                with self.assertRaises(ValueError):
                    self.collect(opener=lambda *_args, **_kwargs: self.fail("must validate before download"))
                self.assertFalse(self.destination.exists())

    def test_rejects_traversal_multi_renderer_duplicate_pair_and_duplicate_attempt(self):
        for task in ({"scene": "../bad", "renderer": "blender"}, {"scene": "gi-basic", "renderer": "all"},
                     {"scene": "gi-basic", "renderer": "webgpu-new,blender"}):
            with self.subTest(task=task):
                job = dict(self.job, tasks=[task])
                with self.assertRaises(ValueError):
                    collector.plan(job, {"outputs": []})
        with self.assertRaisesRegex(ValueError, "duplicate scene/renderer"):
            collector.plan(dict(self.job, tasks=[self.job["tasks"][0]] * 2), {"outputs": []})
        with self.assertRaisesRegex(ValueError, "multiple outputs"):
            collector.plan(self.job, {"outputs": [self.output(0)] * 2})

    def test_default_task_parameters_match_the_container(self):
        selected, missing, expected = collector.plan(dict(self.job, tasks=[{}]), {"outputs": [self.output(0)]})
        self.assertEqual(list(selected), [("gi-basic", "webgpu-new")])
        self.assertEqual((missing, expected), ([], 1))

    def test_bad_http_mime_or_size_does_not_replace_existing_image(self):
        image = self.destination / "gi-basic" / "beauty" / "webgpu-new.avif"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"previous valid render")
        self.listing["outputs"] = [self.output(0)]
        for data, mime in ((b"avif", "text/html"), (b"bad", "image/avif"), (b"too long", "image/avif")):
            with self.subTest(data=data, mime=mime), self.assertRaisesRegex(RuntimeError, "Downloads failed"):
                self.collect(opener=lambda *_args, **_kwargs: Response(data, mime))
            self.assertEqual(image.read_bytes(), b"previous valid render")
            self.assertEqual(list(image.parent.iterdir()), [image])

    def test_failed_http_request_is_actionable(self):
        def opener(*_args, **_kwargs):
            raise OSError("expired signed URL")
        with self.assertRaisesRegex(RuntimeError, "refresh outputs export.*gi-basic/"):
            self.collect(opener=opener)

    def test_download_concurrency_is_bounded(self):
        self.job["tasks"] = [{"scene": f"gi-{index}", "renderer": "blender"} for index in range(12)]
        self.listing["outputs"] = [self.output(index) for index in range(12)]
        active = peak = 0
        lock = threading.Lock()
        def opener(*_args, **_kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            return Response()
        self.collect(opener=opener, workers=3)
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 3)
        for workers in (0, 9, True):
            with self.assertRaisesRegex(ValueError, "workers"):
                self.collect(workers=workers)

    def test_symlink_parent_cannot_write_outside_results(self):
        self.destination.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (self.destination / "gi-basic").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "escaping"):
            self.collect()
        self.assertEqual(list(outside.rglob("*.avif")), [])

    def test_cli_prints_partial_report_and_explicit_warning(self):
        self.job["status"] = "running"
        job_path = self.root / "job.json"
        outputs_path = self.root / "outputs.json"
        job_path.write_text(json.dumps(self.job))
        outputs_path.write_text('{"outputs": []}')
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(collector, "ROOT", self.root), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            # ROOT/results/fidelity.json is the CLI's normal source configuration.
            (self.root / "results").mkdir()
            shutil_config = self.root / "results" / "fidelity.json"
            shutil_config.write_bytes(self.config.read_bytes())
            status = collector.main(["--job", str(job_path), "--outputs", str(outputs_path), "--output", str(self.destination)])
        self.assertEqual(status, 0)
        self.assertFalse(json.loads(output.getvalue())["complete"])
        self.assertIn("Partial collection", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
