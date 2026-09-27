"""Scene states (issue #7): the save_output subfolder / name fields and render-time state offsets."""

import base64
import io
import json
import os
import sys
import tempfile
import types
import unittest

from PIL import Image


from helpers.unicanvas_package import load_unicanvas_package


def _stub_torch():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    return fake_torch


# The whole package under a private name with a stub torch: the suite runs without torch.
UNICANVAS = load_unicanvas_package("vnccs_unicanvas_scene_states_test", torch_module=_stub_torch())
save_output = UNICANVAS.save_output


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class SubfolderSanitizingTests(unittest.TestCase):
    def test_accepts_relative_paths_up_to_two_levels(self):
        self.assertEqual(save_output._sanitize_output_subfolder(""), "")
        self.assertEqual(save_output._sanitize_output_subfolder(None), "")
        self.assertEqual(save_output._sanitize_output_subfolder("Scene 1"), "Scene 1")
        self.assertEqual(save_output._sanitize_output_subfolder("scene/day"), os.path.join("scene", "day"))
        self.assertEqual(save_output._sanitize_output_subfolder("scene\\night"), os.path.join("scene", "night"))

    def test_refuses_parent_references(self):
        for value in ("..", "../x", "scene/..", "a/../b", "./scene"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                save_output._sanitize_output_subfolder(value)

    def test_refuses_absolute_paths(self):
        for value in ("/tmp/x", "\\\\server\\share", "C:\\out", "c:/out"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                save_output._sanitize_output_subfolder(value)

    def test_refuses_depth_three(self):
        with self.assertRaises(ValueError):
            save_output._sanitize_output_subfolder("a/b/c")

    def test_refuses_non_string(self):
        with self.assertRaises(ValueError):
            save_output._sanitize_output_subfolder(["a"])

    def test_names_lose_path_characters(self):
        self.assertEqual(save_output._sanitize_output_name("Day: Anna/Ben?.png"), "Day_ Anna_Ben_")
        self.assertEqual(save_output._sanitize_output_name(".."), "")
        self.assertEqual(save_output._sanitize_output_name(None), "")


class NamedSaveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.previous = sys.modules.get("folder_paths")
        stub = types.ModuleType("folder_paths")
        stub.get_output_directory = lambda: self.tmp.name
        sys.modules["folder_paths"] = stub

    def tearDown(self):
        if self.previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self.previous

    def test_state_export_writes_named_files_into_a_subfolder(self):
        image = _data_url(Image.new("RGBA", (4, 4), (1, 2, 3, 255)))
        first = save_output._run_unicanvas_save_output({"image": image, "subfolder": "My Scene", "name": "Day"})
        second = save_output._run_unicanvas_save_output({"image": image, "subfolder": "My Scene", "name": "Day"})
        folder = os.path.join(self.tmp.name, "My Scene")
        self.assertEqual(first["path"], os.path.join(folder, "Day.png"))
        self.assertEqual(second["path"], os.path.join(folder, "Day-2.png"))
        self.assertTrue(os.path.isfile(first["path"]))

    def test_bad_subfolder_writes_nothing(self):
        image = _data_url(Image.new("RGBA", (4, 4), (1, 2, 3, 255)))
        for value in ("../escape", "/abs", "a/b/c"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                save_output._run_unicanvas_save_output({"image": image, "subfolder": value})
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_default_name_is_unchanged(self):
        image = _data_url(Image.new("RGBA", (4, 4), (1, 2, 3, 255)))
        result = save_output._run_unicanvas_save_output({"image": image})
        self.assertRegex(os.path.basename(result["path"]), r"^unicanvas-\d+-\d+\.png$")


class StateOffsetRenderTests(unittest.TestCase):
    def state(self, offset=None):
        character = Image.new("RGBA", (2, 2), (255, 0, 0, 255))
        layer = {"id": "a", "type": "raster", "visible": True, "opacity": 1, "crop": {"x": 1, "y": 1, "width": 2, "height": 2}, "dataURL": _data_url(character)}
        if offset is not None:
            layer["stateOffset"] = offset
        return {"version": 2, "origin": {"x": 0, "y": 0}, "bbox": {"x": 0, "y": 0, "width": 8, "height": 8}, "layers": [layer]}

    def test_offset_moves_the_layer_at_render_time(self):
        plain = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state()))
        moved = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state({"x": 4, "y": 3})))
        self.assertEqual(plain.getpixel((1, 1)), (255, 0, 0, 255))
        self.assertEqual(moved.getpixel((1, 1)), (0, 0, 0, 0))
        self.assertEqual(moved.getpixel((5, 4)), (255, 0, 0, 255))
        self.assertEqual(moved.getpixel((6, 5)), (255, 0, 0, 255))

    def test_depth_scale_scales_around_the_feet_then_moves(self):
        # The 2x2 layer at (1, 1) with its feet at (2, 3): scale 2 around the feet, then +1 x.
        scaled = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state({"x": 1, "y": 0, "scale": 2, "ax": 2, "ay": 3})))
        # Rest rect (1, 1, 2, 2) -> (0, -1, 4, 4) around the feet, +1 x -> x 1..5, y -1..3 (clipped at 0).
        self.assertEqual(scaled.split()[3].getbbox(), (1, 0, 5, 3))
        self.assertEqual(scaled.getpixel((3, 2)), (255, 0, 0, 255))

    def test_a_scale_of_one_or_a_bad_scale_is_a_plain_offset(self):
        moved = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state({"x": 4, "y": 3})))
        for scale in (1, 0, -2, "x", None):
            with self.subTest(scale=scale):
                other = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state({"x": 4, "y": 3, "scale": scale, "ax": 2, "ay": 3})))
                self.assertEqual(moved.tobytes(), other.tobytes())

    def test_missing_or_bad_offset_is_ignored(self):
        plain = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state()))
        bad = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(self.state("oops")))
        self.assertEqual(plain.tobytes(), bad.tobytes())


if __name__ == "__main__":
    unittest.main()
