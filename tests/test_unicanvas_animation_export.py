"""Timeline animation export (issue #18): job lifecycle, encoders and the output subfolder."""

import base64
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

from PIL import Image


from helpers.unicanvas_package import load_unicanvas_package


def _stub_torch():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    return fake_torch


# The whole package under a private name with a stub torch: the suite runs without torch.
UNICANVAS = load_unicanvas_package("vnccs_unicanvas_animation_export_test", torch_module=_stub_torch())
export = UNICANVAS.animation_export

try:
    import av  # noqa: F401  (PyAV ships with ComfyUI; the CI image may not have it)
    HAVE_AV = True
except Exception:
    HAVE_AV = False


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _frame(index, size=(48, 32), alpha=255):
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    # A moving block: every frame differs, so encoders cannot merge them.
    for x in range(index * 3, index * 3 + 8):
        for y in range(4, 20):
            if x < size[0] and y < size[1]:
                image.putpixel((x, y), (200, 40 + index * 10, 90, alpha))
    return image


class ExportTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.output = os.path.join(self.tmp.name, "output")
        self.temp = os.path.join(self.tmp.name, "temp")
        os.makedirs(self.output)
        folder_paths = sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
        self.patches = [
            mock.patch.object(folder_paths, "get_output_directory", lambda: self.output, create=True),
            mock.patch.object(folder_paths, "get_temp_directory", lambda: self.temp, create=True),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def run_job(self, fmt, frames=10, size=(48, 32), batch=3, **extra):
        job = export.begin_animation_export({"format": fmt, "fps": 12, "width": size[0], "height": size[1], "frame_count": frames, "name": "clip", **extra})
        job_id = job["job_id"]
        for start in range(0, frames, batch):
            urls = [_data_url(_frame(index, size)) for index in range(start, min(frames, start + batch))]
            export.add_animation_frames({"job_id": job_id, "start": start, "frames": urls})
        return export.end_animation_export({"job_id": job_id})


class LifecycleTests(ExportTestCase):
    def test_png_sequence_keeps_order_and_alpha(self):
        result = self.run_job("png")
        self.assertEqual(result["files"], 10)
        self.assertTrue(result["path"].startswith(os.path.join(self.output, "unicanvas_animation")))
        names = sorted(os.listdir(result["path"]))
        self.assertEqual(names, [f"clip_{index:05d}.png" for index in range(10)])
        for index, name in enumerate(names):
            with Image.open(os.path.join(result["path"], name)) as saved:
                self.assertEqual(saved.size, (48, 32))
                self.assertEqual(saved.convert("RGBA").tobytes(), _frame(index).tobytes())
                self.assertEqual(saved.convert("RGBA").getpixel((47, 31))[3], 0)
        # The job directory is gone after the encode.
        self.assertEqual(os.listdir(os.path.join(self.temp, "vnccs_unicanvas_animation")), [])

    def test_second_export_gets_a_new_name(self):
        first = self.run_job("png", frames=2)
        second = self.run_job("png", frames=2)
        self.assertNotEqual(first["path"], second["path"])
        self.assertTrue(second["path"].endswith("clip-2"))

    def test_gif_has_every_frame_at_the_right_size(self):
        result = self.run_job("gif")
        with Image.open(result["path"]) as gif:
            self.assertEqual(gif.size, (48, 32))
            self.assertEqual(gif.n_frames, 10)

    @unittest.skipUnless(HAVE_AV, "PyAV is not installed")
    def test_webm_and_mp4_have_every_frame_at_the_right_size(self):
        import av

        for fmt in ("webm", "mp4"):
            result = self.run_job(fmt)
            self.assertTrue(result["path"].endswith(f"clip.{fmt}") or result["path"].endswith(f"clip-2.{fmt}"))
            with av.open(result["path"]) as container:
                stream = container.streams.video[0]
                frames = list(container.decode(stream))
                self.assertEqual(len(frames), 10, fmt)
                self.assertEqual((frames[0].width, frames[0].height), (48, 32), fmt)

    @unittest.skipUnless(HAVE_AV, "PyAV is not installed")
    def test_mp4_pads_odd_sizes(self):
        import av

        result = self.run_job("mp4", frames=3, size=(47, 31))
        with av.open(result["path"]) as container:
            frame = next(container.decode(container.streams.video[0]))
            self.assertEqual((frame.width, frame.height), (48, 32))

    def test_frames_must_arrive_in_order(self):
        job_id = export.begin_animation_export({"format": "png", "fps": 12, "width": 48, "height": 32, "frame_count": 4})["job_id"]
        with self.assertRaises(export.AnimationExportError):
            export.add_animation_frames({"job_id": job_id, "start": 1, "frames": [_data_url(_frame(1))]})
        export.add_animation_frames({"job_id": job_id, "start": 0, "frames": [_data_url(_frame(0))]})
        with self.assertRaises(export.AnimationExportError):
            export.end_animation_export({"job_id": job_id})
        with self.assertRaises(export.AnimationExportError):
            export.add_animation_frames({"job_id": job_id, "start": 1, "frames": [_data_url(_frame(1, size=(10, 10)))]})
        # A rejected batch does not advance the job.
        self.assertEqual(export.animation_export_status(job_id)["received"], 1)

    def test_cancel_deletes_the_job(self):
        job_id = export.begin_animation_export({"format": "gif", "fps": 12, "width": 48, "height": 32, "frame_count": 2})["job_id"]
        export.add_animation_frames({"job_id": job_id, "start": 0, "frames": [_data_url(_frame(0))]})
        self.assertTrue(export.cancel_animation_export({"job_id": job_id})["cancelled"])
        self.assertEqual(os.listdir(os.path.join(self.temp, "vnccs_unicanvas_animation")), [])
        with self.assertRaises(export.AnimationExportError):
            export.animation_export_status(job_id)
        self.assertEqual(os.listdir(self.output), [])


class ValidationTests(ExportTestCase):
    def begin(self, **overrides):
        payload = {"format": "webm", "fps": 24, "width": 64, "height": 64, "frame_count": 10, **overrides}
        return export.begin_animation_export(payload)

    def test_refuses_unsafe_subfolders(self):
        for subfolder in ("../escape", "/abs", "a/../../b", "C:\\x", "a/b/c"):
            with self.assertRaises(export.AnimationExportError, msg=subfolder):
                self.begin(subfolder=subfolder)

    def test_refuses_bad_formats_and_sizes(self):
        for overrides in ({"format": "avi"}, {"fps": 0}, {"fps": 61}, {"width": 0}, {"height": 5000}, {"frame_count": 0}, {"frame_count": 3601}, {"fps": "x"}):
            with self.assertRaises(export.AnimationExportError, msg=str(overrides)):
                self.begin(**overrides)

    def test_names_are_sanitized(self):
        job_id = self.begin(format="png", frame_count=1, width=48, height=32, name="../a:b", subfolder="Scene 1/takes")["job_id"]
        export.add_animation_frames({"job_id": job_id, "start": 0, "frames": [_data_url(_frame(0))]})
        result = export.end_animation_export({"job_id": job_id})
        self.assertEqual(result["path"], os.path.join(os.path.realpath(self.output), "Scene 1", "takes", "_a_b"))

    def test_refuses_non_png_frames(self):
        job_id = self.begin(width=48, height=32)["job_id"]
        buffer = io.BytesIO()
        Image.new("RGB", (48, 32)).save(buffer, format="JPEG")
        jpeg = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        for frame in ("nope", jpeg):
            with self.assertRaises(export.AnimationExportError):
                export.add_animation_frames({"job_id": job_id, "start": 0, "frames": [frame]})

    def test_unknown_jobs(self):
        for job_id in ("", "../x", "0" * 32):
            with self.assertRaises(export.AnimationExportError):
                export.end_animation_export({"job_id": job_id})


class RouteTests(unittest.TestCase):
    def test_routes_cover_the_protocol(self):
        routes = export.animation_export_routes(types.SimpleNamespace(json_response=lambda *a, **k: None), lambda request, size: True)
        self.assertEqual(
            [(method, path) for method, path, _ in routes],
            [
                ("POST", "/vnccs/unicanvas/animation/begin"),
                ("POST", "/vnccs/unicanvas/animation/frames"),
                ("POST", "/vnccs/unicanvas/animation/end"),
                ("POST", "/vnccs/unicanvas/animation/cancel"),
                ("GET", "/vnccs/unicanvas/animation/status/{job_id}"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
