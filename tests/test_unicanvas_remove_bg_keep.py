"""Remove background keep areas (issue #13): the ``keep`` mask on /vnccs/unicanvas/remove_bg."""

import base64
import io
import types
import unittest

import numpy as np
from PIL import Image

from helpers.unicanvas_package import load_unicanvas_package


def _stub_torch():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    return fake_torch


# The whole package under a private name with a stub torch: the suite runs without torch.
UNICANVAS = load_unicanvas_package("vnccs_unicanvas_remove_bg_keep_test", torch_module=_stub_torch())
remove_bg = UNICANVAS.remove_bg


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _decode(data_url):
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1]))).convert("RGBA")


def _subject_image():
    """8x6 gradient: every pixel has its own color, so a copied color is traceable."""
    arr = np.zeros((6, 8, 3), dtype=np.uint8)
    arr[..., 0] = np.arange(8)[None, :] * 30
    arr[..., 1] = np.arange(6)[:, None] * 40
    arr[..., 2] = 90
    return Image.fromarray(arr, mode="RGB")


def _keep_mask(size, box):
    """White box on black: the keep area."""
    mask = Image.new("RGB", size, (0, 0, 0))
    mask.paste((255, 255, 255), box)
    return mask


class _Patch:
    """Minimal attribute patch (the suite runs as a plain script in CI, without pytest)."""

    def __init__(self):
        self._undo = []

    def set(self, target, name, value):
        self._undo.append((target, name, getattr(target, name)))
        setattr(target, name, value)

    def undo(self):
        while self._undo:
            target, name, value = self._undo.pop()
            setattr(target, name, value)


class _TransparentRemover(remove_bg.BackgroundRemover):
    """A backend that removes everything (white RGB, alpha 0) and records what it saw."""

    key = "test_transparent"

    def __init__(self):
        self.seen = None

    def remove(self, image, request):
        self.seen = request
        return Image.new("RGBA", image.size, (255, 255, 255, 0))


class RemoveBgKeepTests(unittest.TestCase):
    def setUp(self):
        self.patch = _Patch()
        self.remover = _TransparentRemover()
        self.patch.set(remove_bg, "BACKGROUND_REMOVERS", dict(remove_bg.BACKGROUND_REMOVERS))
        remove_bg.register_background_remover(self.remover)

    def tearDown(self):
        self.patch.undo()

    def run_remove_bg(self, method, image, keep=None):
        payload = {"method": method, "image": _data_url(image)}
        if keep is not None:
            payload["keep"] = keep if isinstance(keep, str) else _data_url(keep)
        return remove_bg._run_unicanvas_remove_bg(payload)

    # --- alpha merge -------------------------------------------------------------------

    def test_apply_keep_mask_forces_the_keep_area_opaque_and_leaves_the_rest(self):
        image = _subject_image()
        backend = Image.new("RGBA", image.size, (255, 255, 255, 0))
        backend.putpixel((0, 0), (10, 20, 30, 77))  # outside the keep area: untouched
        keep = Image.new("L", image.size, 0)
        keep.paste(255, (2, 1, 5, 4))

        out = remove_bg.apply_keep_mask(backend, image, keep)

        arr = np.asarray(out)
        original = np.asarray(image)
        self.assertTrue((arr[1:4, 2:5, 3] == 255).all())
        self.assertTrue((arr[1:4, 2:5, :3] == original[1:4, 2:5]).all())
        self.assertEqual(out.getpixel((0, 0)), (10, 20, 30, 77))
        outside = np.ones(arr.shape[:2], dtype=bool)
        outside[1:4, 2:5] = False
        outside[0, 0] = False
        self.assertTrue((arr[outside] == (255, 255, 255, 0)).all())

    def test_apply_keep_mask_takes_the_max_of_backend_and_keep_alpha(self):
        image = _subject_image()
        backend = Image.new("RGBA", image.size, (0, 0, 0, 200))
        keep = Image.new("L", image.size, 100)
        out = np.asarray(remove_bg.apply_keep_mask(backend, image, keep))
        self.assertTrue((out[..., 3] == 200).all())

    def test_every_registered_backend_gets_the_merge(self):
        image = _subject_image()
        result = self.run_remove_bg("test_transparent", image, _keep_mask(image.size, (1, 1, 4, 3)))
        out = np.asarray(_decode(result["alpha"]))
        self.assertTrue((out[1:3, 1:4, 3] == 255).all())
        self.assertTrue((out[1:3, 1:4, :3] == np.asarray(image)[1:3, 1:4]).all())
        self.assertEqual(int(out[..., 3].sum()), 255 * 6)
        self.assertIsNotNone(self.remover.seen.keep)

    def test_birefnet_result_keeps_the_marked_pixels(self):
        image = _subject_image()

        def fake_masker(img_bgr):
            mask = np.zeros(img_bgr.shape[:2], dtype=np.uint8)
            mask[:, 6:] = 1  # the "subject" is the right edge
            return mask, None

        self.patch.set(remove_bg, "_uc_load_birefnet_masker", lambda: fake_masker)
        plain = np.asarray(_decode(self.run_remove_bg("birefnet", image)["alpha"]))
        kept = np.asarray(_decode(self.run_remove_bg("birefnet", image, _keep_mask(image.size, (0, 0, 2, 6)))["alpha"]))

        self.assertTrue((plain[:, :6, 3] == 0).all())
        self.assertTrue((kept[:, :2, 3] == 255).all())
        self.assertTrue((kept[:, 6:, 3] == 255).all())
        self.assertTrue((kept[:, 2:6] == plain[:, 2:6]).all())

    def test_without_a_keep_mask_the_result_is_unchanged(self):
        image = _subject_image()
        baseline = self.run_remove_bg("test_transparent", image)
        self.assertIsNone(self.remover.seen.keep)
        empty = self.run_remove_bg("test_transparent", image, _keep_mask(image.size, (0, 0, 0, 0)))
        self.assertIsNone(self.remover.seen.keep)
        blank = self.run_remove_bg("test_transparent", image, "")
        self.assertEqual(baseline, empty)
        self.assertEqual(baseline, blank)

    # --- edit model instruction ----------------------------------------------------------

    def edit_request(self, settings, keep=True):
        request = remove_bg.RemoveBgRequest(
            method="edit", raw_method="edit", edit_model="qwen_image21", payload={},
            edit_settings=settings, keep=Image.new("L", (2, 2), 255) if keep else None,
        )
        return remove_bg.EditModelRemover().with_keep_mask(request)

    def test_edit_model_appends_the_keep_instruction(self):
        request = self.edit_request({"prompt": "Remove the background", "seed": 3})
        self.assertEqual(
            request.edit_settings["prompt"],
            "Remove the background\nKeep the marked regions fully visible in the output.",
        )
        self.assertEqual(request.edit_settings["seed"], 3)

    def test_edit_model_keep_instruction_follows_the_default_prompt(self):
        request = self.edit_request({"seed": 1})
        self.assertEqual(
            request.edit_settings["prompt"],
            f"{remove_bg.UC_REMOVE_BG_DEFAULT_PROMPT}\n{remove_bg.UC_REMOVE_BG_KEEP_INSTRUCTION}",
        )

    def test_edit_model_prompt_is_untouched_without_a_keep_mask(self):
        settings = {"prompt": "Remove the background"}
        request = self.edit_request(settings, keep=False)
        self.assertIs(request.edit_settings, settings)

    def test_other_backends_keep_the_request_as_is(self):
        request = remove_bg.RemoveBgRequest(
            method="rembg", raw_method="rembg", edit_model="", payload={}, keep=Image.new("L", (1, 1), 255),
        )
        for key in ("birefnet", "rembg", "sam3"):
            self.assertIs(remove_bg.BACKGROUND_REMOVERS[key].with_keep_mask(request), request)

    # --- validation ----------------------------------------------------------------------

    def test_malformed_keep_is_rejected(self):
        image = _subject_image()
        for bad in ("not a data url", "data:image/png;base64,@@@@", 42, "data:image/jpeg;base64,AAAA"):
            with self.subTest(keep=bad):
                with self.assertRaises(ValueError) as ctx:
                    remove_bg._run_unicanvas_remove_bg({"method": "test_transparent", "image": _data_url(image), "keep": bad})
                self.assertIn("keep mask", str(ctx.exception))
                self.assertIsNone(self.remover.seen)

    def test_keep_of_another_size_is_rejected(self):
        image = _subject_image()
        with self.assertRaises(ValueError) as ctx:
            self.run_remove_bg("test_transparent", image, _keep_mask((4, 4), (0, 0, 2, 2)))
        self.assertIn("4x4", str(ctx.exception))

    def test_oversized_keep_is_rejected(self):
        image = _subject_image()
        self.patch.set(remove_bg, "_MAX_UPLOAD_BYTES", 16)
        with self.assertRaises(ValueError) as ctx:
            self.run_remove_bg("test_transparent", image, _keep_mask(image.size, (0, 0, 8, 6)))
        self.assertIn("too large", str(ctx.exception))
        self.assertIsNone(self.remover.seen)

    def test_keep_with_more_pixels_than_the_image_is_too_large(self):
        # The decoder's ImageTooLargeError maps to the "too large" message, not "invalid".
        image = _subject_image()
        with self.assertRaises(ValueError) as ctx:
            self.run_remove_bg("test_transparent", image, _keep_mask((16, 12), (0, 0, 8, 6)))
        self.assertEqual(str(ctx.exception), remove_bg.UC_REMOVE_BG_KEEP_TOO_LARGE)
        self.assertIsNone(self.remover.seen)


if __name__ == "__main__":
    unittest.main()
