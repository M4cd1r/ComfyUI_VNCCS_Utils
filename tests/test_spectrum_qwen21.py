"""CPU unit tests for the vendored Spectrum (Qwen-Image-2.1) package.

Ported from the upstream test-suite of Comfyui-Spectrum-Qwen2.1
(https://github.com/awdqwdasdg/Comfyui-Spectrum-Qwen2.1), Copyright (c) 2026
ComfyUI-Spectrum-QwenImage21 contributors, MIT License. The harness is adapted
to this repository's stubbed conftest: imports go through nodes.spectrum_qwen21,
the fake model is inlined here, and the ComfyUI stubs attach to the existing
conftest stubs instead of replacing them. Every test runs on CPU.
"""
from __future__ import annotations


# ===========================================================================
# fake_model.py (ported from upstream tests/, harness adapted)
# ===========================================================================

"""A CPU-friendly replica of ComfyUI's Qwen-Image-2.1 transformer.

Mirrors the structure and the exact call-flow of
comfy/ldm/qwen_image21/model.py at a tiny scale, including:

* the WrapperExecutor call pattern around ``_forward``,
* the timestep embedding math (t = ((t*1000)/1000), temb rows
  [batch..., t=0]),
* the output tail (norm_out -> proj_out -> transpose/reshape),
* the structural attributes consumed by the Spectrum node
  (transformer_blocks, img_in, txt_in, inner_dim, out_channels, ...).

The block stack is deliberately simple, but every component is a smooth
(analytic) function of the timestep, so the final hidden state is a
smooth function of diffusion time -- exactly the regime the Spectrum
forecaster is designed for.
"""


import math
from typing import Any, Callable

import torch
import torch.nn as nn
import torch.nn.functional as F


def timestep_embedding(t: torch.Tensor, dim: int, max_period: int = 10000) -> torch.Tensor:
    """Standard sinusoidal embedding (same as comfy.ldm.flux.layers)."""
    half = dim // 2
    freqs = torch.exp(
        -math.log(max_period)
        * torch.arange(half, dtype=torch.float32, device=t.device)
        / half
    )
    args = t.float()[:, None] * freqs[None]
    embedding = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
    if dim % 2:
        embedding = torch.cat(
            [embedding, torch.zeros_like(embedding[:, :1])], dim=-1
        )
    return embedding


class FakeTimestepProjEmbeddings(nn.Module):
    """Replica of qwen_image21.model.TimestepProjEmbeddings."""

    def __init__(self, embedding_dim: int, freq_dim: int = 64):
        super().__init__()
        self.linear_1 = nn.Linear(freq_dim, embedding_dim)
        self.linear_2 = nn.Linear(embedding_dim, embedding_dim)
        self.freq_dim = freq_dim

    def forward(self, timestep: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
        return self.linear_2(
            F.silu(self.linear_1(timestep_embedding(timestep.float(), self.freq_dim).to(dtype)))
        )


class FakeTextProjection(nn.Module):
    def __init__(self, in_dim: int, hidden: int):
        super().__init__()
        self.in_layer = nn.Linear(in_dim, hidden, bias=False)
        self.out_layer = nn.Linear(hidden, hidden, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.out_layer(F.gelu(self.in_layer(x), approximate="tanh"))


class FakeLastLayer(nn.Module):
    """Replica of qwen_image21.model.LastLayer (scale-only AdaLN)."""

    def __init__(self, dim: int):
        super().__init__()
        self.linear = nn.Linear(dim, dim, bias=False)
        self.norm = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)

    def forward(self, x: torch.Tensor, temb: torch.Tensor) -> torch.Tensor:
        scale = self.linear(F.silu(temb)).unsqueeze(1)
        return self.norm(x) * (1 + scale)


class FakeTransformerBlock(nn.Module):
    """Smooth-in-t block (stand-in for QwenImage21TransformerBlock)."""

    def __init__(self, dim: int):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
        self.net1 = nn.Sequential(nn.Linear(dim, 2 * dim), nn.SiLU(), nn.Linear(2 * dim, dim))
        self.norm2 = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
        self.net2 = nn.Sequential(nn.Linear(dim, 2 * dim), nn.SiLU(), nn.Linear(2 * dim, dim))

    def forward(self, x: torch.Tensor, mod: tuple) -> torch.Tensor:
        scale1, gate1, scale2, gate2 = mod
        x = x + gate1 * self.net1(self.norm1(x) * (1 + scale1))
        x = x + gate2 * self.net2(self.norm2(x) * (1 + scale2))
        return x


class FakeExecutor:
    """Replica of comfy.patcher_extension.WrapperExecutor."""

    def __init__(self, original: Callable, class_obj: Any, wrappers: list, idx: int = 0):
        self.original = original
        self.class_obj = class_obj
        self.wrappers = list(wrappers)
        self.idx = idx
        self.is_last = idx == len(self.wrappers)

    def __call__(self, *args, **kwargs):
        new = FakeExecutor(self.original, self.class_obj, self.wrappers, self.idx + 1)
        return new.execute(*args, **kwargs)

    def execute(self, *args, **kwargs):
        if self.is_last:
            return self.original(*args, **kwargs)
        return self.wrappers[self.idx](self, *args, **kwargs)


class FakeQwenImage21Model(nn.Module):
    """Small-scale replica of QwenImage21Transformer2DModel."""

    def __init__(
        self,
        in_channels: int = 8,
        out_channels: int = 8,
        inner_dim: int = 32,
        num_layers: int = 4,
        context_dim: int = 16,
        txt_len: int = 7,
        seed: int = 0,
    ):
        super().__init__()
        torch.manual_seed(seed)
        self.inner_dim = inner_dim
        self.out_channels = out_channels
        self.in_channels = in_channels
        self.txt_len = txt_len

        self.time_text_embed = FakeTimestepProjEmbeddings(inner_dim)
        self.txt_in = FakeTextProjection(context_dim, inner_dim)
        self.img_in = nn.Linear(in_channels, inner_dim, bias=False)
        self.modulation = nn.Sequential(
            nn.SiLU(), nn.Linear(inner_dim, 4 * inner_dim, bias=False)
        )
        self.transformer_blocks = nn.ModuleList(
            [FakeTransformerBlock(inner_dim) for _ in range(num_layers)]
        )
        self.norm_out = FakeLastLayer(inner_dim)
        self.proj_out = nn.Linear(inner_dim, out_channels, bias=False)

    def _forward(
        self,
        x: torch.Tensor,
        timesteps: torch.Tensor,
        context: Any = None,
        ref_latents: Any = None,
        image_slots: Any = None,
        transformer_options: dict = {},
        **kwargs: Any,
    ) -> torch.Tensor:
        batch, _, height, width = x.shape
        dtype = x.dtype

        txt = self.txt_in(context)
        img = self.img_in(x.flatten(2).transpose(1, 2))
        hidden = torch.cat([txt, img], dim=1)
        prefix_len = hidden.shape[1] - height * width

        t = ((timesteps * 1000).to(dtype) / 1000).to(dtype)
        temb = self.time_text_embed(torch.cat([t, t.new_zeros(1)]), dtype)
        scale1, gate1, scale2, gate2 = self.modulation(temb[:-1]).chunk(4, dim=-1)
        mod = (
            scale1.unsqueeze(1),
            gate1.tanh().unsqueeze(1),
            scale2.unsqueeze(1),
            gate2.tanh().unsqueeze(1),
        )

        for block in self.transformer_blocks:
            hidden = block(hidden, mod)

        hidden = self.norm_out(hidden[:, prefix_len:], temb[:-1])
        hidden = self.proj_out(hidden)
        return hidden.transpose(1, 2).reshape(batch, self.out_channels, height, width)

    def forward(
        self,
        x: torch.Tensor,
        timesteps: torch.Tensor,
        context: Any = None,
        ref_latents: Any = None,
        image_slots: Any = None,
        transformer_options: Any = None,
        **kwargs: Any,
    ) -> torch.Tensor:
        if not isinstance(transformer_options, dict):
            transformer_options = {}
        wrappers: list = []
        for wrapper_list in (
            transformer_options.get("wrappers", {}).get("diffusion_model", {}).values()
        ):
            wrappers.extend(wrapper_list)
        return FakeExecutor(self._forward, self, wrappers).execute(
            x, timesteps, context, ref_latents, image_slots, transformer_options, **kwargs
        )


class NotAQwenModel(nn.Module):
    """Model failing the structural check (no txt_in/transformer_blocks)."""

    def __init__(self):
        super().__init__()
        self.linear = nn.Linear(4, 4)

    def forward(self, x: torch.Tensor, *args: Any, **kwargs: Any) -> torch.Tensor:
        return self.linear(x)


# ===========================================================================
# test_chebyshev.py (ported from upstream tests/, harness adapted)
# ===========================================================================


import sys
import unittest
from pathlib import Path

import torch


from nodes.spectrum_qwen21.chebyshev import (  # noqa: E402
    HistoryWeightChebyshevForecaster,
    chebyshev_basis,
    normalize_step_position,
)


class ChebyshevBasisTest(unittest.TestCase):
    def test_basis_shape_and_values(self) -> None:
        x = torch.tensor([-1.0, 0.0, 0.5, 1.0])
        basis = chebyshev_basis(x, 4)
        self.assertEqual(tuple(basis.shape), (4, 5))
        # T_0 = 1, T_1 = x, T_2 = 2x^2 - 1
        self.assertTrue(torch.allclose(basis[:, 0], torch.ones(4)))
        self.assertTrue(torch.allclose(basis[:, 1], x))
        self.assertTrue(torch.allclose(basis[:, 2], 2 * x * x - 1))

    def test_normalize_step_position(self) -> None:
        self.assertAlmostEqual(normalize_step_position(0, 20), -1.0)
        self.assertAlmostEqual(normalize_step_position(19, 20), 1.0)
        self.assertAlmostEqual(normalize_step_position(10, 20), 2 * 10 / 19 - 1, places=5)
        self.assertEqual(normalize_step_position(0, 1), 0.0)
        # clamped for out-of-range indices
        self.assertEqual(normalize_step_position(25, 20), 1.0)


class ForecasterMathTest(unittest.TestCase):
    def _make(self, degree=4, lam=0.1, history=8, blend=1.0):
        return HistoryWeightChebyshevForecaster(
            degree=degree, ridge_lambda=lam, max_history=history, blend_weight=blend
        )

    def test_matches_direct_ridge_solve(self) -> None:
        """History-weight prediction must equal the paper's Eq. (12)-(14)."""
        torch.manual_seed(3)
        degree, lam, k = 4, 0.1, 7
        coords = [-1.0, -0.7, -0.4, -0.1, 0.3, 0.6, 0.9]
        feature = torch.randn(2, 11, 5, dtype=torch.float32)

        forecaster = self._make(degree=degree, lam=lam, history=k, blend=1.0)
        for c in coords:
            forecaster.update(c, feature + c)  # distinct values per anchor

        design = chebyshev_basis(torch.tensor(coords), degree)  # (K, P)
        target_matrix = torch.stack([feature + c for c in coords]).reshape(k, -1)
        gram = design.t() @ design + lam * torch.eye(degree + 1)
        coeffs = torch.linalg.solve(gram, design.t() @ target_matrix)

        for probe in (-0.85, 0.0, 0.45, 0.99):
            phi = chebyshev_basis(torch.tensor([probe]), degree)
            expected = (phi @ coeffs).reshape(feature.shape)
            predicted = forecaster.predict(probe)
            self.assertTrue(
                torch.allclose(predicted, expected, atol=2e-3, rtol=1e-3),
                f"mismatch at probe={probe}",
            )

    def test_exact_recovery_of_low_degree_polynomial(self) -> None:
        degree = 4
        forecaster = self._make(degree=degree, lam=0.0, history=8)
        # h(coord) = 3 + 2*coord - coord^2 (degree 2 < 4 -> exact fit)
        for c in [-1.0, -0.6, -0.2, 0.2, 0.6, 1.0]:
            value = 3.0 + 2.0 * c - c * c
            forecaster.update(c, torch.full((1, 4, 3), value))
        for probe in (-0.9, -0.35, 0.11, 0.77, 0.98):
            expected = 3.0 + 2.0 * probe - probe * probe
            predicted = forecaster.predict(probe)
            self.assertTrue(
                torch.allclose(predicted, torch.full((1, 4, 3), expected), atol=1e-4)
            )

    def test_blend_zero_is_pure_linear_extrapolation(self) -> None:
        forecaster = self._make(degree=4, lam=0.1, history=6, blend=0.0)
        # five collinear anchors; v(coord) = 1 + 2*(coord + 1)
        for c in [-1.0, -0.5, 0.0, 0.5, 1.0]:
            forecaster.update(c, torch.full((2, 3), 1.0 + 2.0 * (c + 1.0)))
        for probe in (0.25, 0.9):
            expected = 1.0 + 2.0 * (probe + 1.0)
            predicted = forecaster.predict(probe)
            self.assertTrue(
                torch.allclose(predicted, torch.full((2, 3), expected), atol=1e-4)
            )

    def test_blend_mixes_spectral_and_linear(self) -> None:
        torch.manual_seed(7)
        blend = 0.5
        forecaster_s = self._make(blend=1.0)
        forecaster_l = self._make(blend=0.0)
        forecaster_m = self._make(blend=blend)
        for c in [-1.0, -0.5, 0.0, 0.5, 1.0]:
            f = torch.randn(1, 6)
            forecaster_s.update(c, f)
            forecaster_l.update(c, f.clone())
            forecaster_m.update(c, f.clone())
        probe = 0.75
        expected = blend * forecaster_s.predict(probe) + (1 - blend) * forecaster_l.predict(probe)
        self.assertTrue(torch.allclose(forecaster_m.predict(probe), expected, atol=1e-5))

    def test_history_trim_is_fifo(self) -> None:
        forecaster = self._make(degree=2, history=3)
        for i in range(6):
            forecaster.update(float(i) / 5.0, torch.full((1, 2), float(i)))
        self.assertEqual(forecaster.history_size, 3)
        self.assertTrue(torch.allclose(forecaster._anchors[0].feature, torch.tensor([[3.0, 3.0]])))

    def test_not_ready_raises(self) -> None:
        forecaster = self._make(degree=4, history=8)
        forecaster.update(0.0, torch.zeros(1, 2))
        with self.assertRaises(RuntimeError):
            forecaster.predict(0.5)

    def test_shape_change_raises_and_reset_recovers(self) -> None:
        forecaster = self._make(degree=2, history=5)
        forecaster.update(0.0, torch.zeros(1, 2))
        with self.assertRaises(ValueError):
            forecaster.update(0.2, torch.zeros(1, 3))
        forecaster.reset()
        forecaster.update(0.0, torch.zeros(1, 3))
        self.assertEqual(tuple(forecaster.feature_shape), (1, 3))

    def test_dtype_preserved_and_sane(self) -> None:
        forecaster = self._make(degree=1, history=5, blend=0.0)
        # values that extrapolate beyond fp16 range must be clamped
        forecaster.update(-1.0, torch.full((1, 4), 60000.0, dtype=torch.float16))
        forecaster.update(-0.8, torch.full((1, 4), -60000.0, dtype=torch.float16))
        out = forecaster.predict(0.5)
        self.assertEqual(out.dtype, torch.float16)
        self.assertTrue(torch.isfinite(out.float()).all())
        self.assertLessEqual(out.float().abs().max().item(), 65504.0 + 1e-3)

    def test_release_features_keeps_signature(self) -> None:
        forecaster = self._make(degree=2, history=5)
        forecaster.update(0.0, torch.zeros(2, 4))
        forecaster.release_features()
        self.assertEqual(forecaster.history_size, 0)
        self.assertEqual(tuple(forecaster.feature_shape), (2, 4))


# ===========================================================================
# test_controller.py (ported from upstream tests/, harness adapted)
# ===========================================================================


import sys
import unittest
from pathlib import Path

import torch


from nodes.spectrum_qwen21.chebyshev import _Anchor  # noqa: E402
from nodes.spectrum_qwen21.config import SpectrumConfig  # noqa: E402
from nodes.spectrum_qwen21.controller import (  # noqa: E402
    decide_actual_or_forecast,
    find_step_index,
    note_decision,
)
from nodes.spectrum_qwen21.state import SpectrumBranchState  # noqa: E402


def _ready_branch(config: SpectrumConfig) -> SpectrumBranchState:
    """Branch whose forecaster pretends to be fully seeded."""
    state = SpectrumBranchState(config=config)
    forecaster = state.forecaster
    forecaster._feature_shape = torch.Size((1, 1))
    forecaster._feature_dtype = torch.float32
    forecaster._storage_device = torch.device("cpu")
    for i in range(config.chebyshev_degree + 1):
        forecaster._anchors.append(
            _Anchor(coord=-1.0 + 2.0 * i / config.chebyshev_degree, feature=torch.zeros(1, 1))
        )
    return state


class FindStepIndexTest(unittest.TestCase):
    def test_exact_match(self) -> None:
        sigmas = torch.tensor([1.0, 0.9, 0.8, 0.5, 0.2, 0.0])
        self.assertEqual(find_step_index(sigmas, torch.tensor([0.8])), 2)
        self.assertEqual(find_step_index(sigmas, torch.tensor([1.0])), 0)
        self.assertEqual(find_step_index(sigmas, torch.tensor([0.0])), 5)

    def test_batched_timestep_uses_first_row(self) -> None:
        sigmas = torch.tensor([1.0, 0.5, 0.0])
        self.assertEqual(find_step_index(sigmas, torch.tensor([0.5, 0.5])), 1)

    def test_bracketing_fallback(self) -> None:
        sigmas = torch.tensor([1.0, 0.8, 0.6, 0.4])
        # 0.7 lies between 0.8 and 0.6 -> index 1
        self.assertEqual(find_step_index(sigmas, torch.tensor([0.7])), 1)

    def test_nearest_fallback(self) -> None:
        sigmas = torch.tensor([1.0, 0.5, 0.0])
        self.assertEqual(find_step_index(sigmas, torch.tensor([-5.0])), 2)

    def test_degenerate_inputs(self) -> None:
        self.assertEqual(find_step_index(torch.tensor([]), torch.tensor([1.0])), -1)
        self.assertEqual(find_step_index(torch.tensor([1.0]), torch.tensor([])), -1)


class ScheduleTest(unittest.TestCase):
    def _simulate(self, config: SpectrumConfig, total_steps: int):
        state = _ready_branch(config)
        decisions = []
        for step in range(total_steps):
            actual, reason = decide_actual_or_forecast(
                state=state,
                step_index=step,
                total_steps=total_steps,
                control_present=False,
                config=config,
            )
            decisions.append((actual, reason))
            note_decision(state, actual, reason, config)
        return decisions, state

    def test_default_schedule_40_steps_matches_paper_pattern(self) -> None:
        config = SpectrumConfig()
        decisions, state = self._simulate(config, total_steps=40)

        actual_steps = {i for i, (a, _) in enumerate(decisions) if a}
        # warmup 0-4, window-rule actuals, protected tail 38-39
        expected = {0, 1, 2, 3, 4, 6, 8, 11, 15, 20, 25, 31, 38, 39}
        self.assertEqual(actual_steps, expected)

        forecasts = [i for i, (a, _) in enumerate(decisions) if not a]
        self.assertEqual(len(forecasts), 40 - len(expected))
        # first forecast happens right after warmup
        self.assertEqual(forecasts[0], 5)
        self.assertEqual(state.actual_count, len(expected))
        self.assertEqual(state.forecast_count, len(forecasts))
        # window grew by 0.75 per window-actual (7 window actuals after warmup)
        self.assertAlmostEqual(
            state.current_window,
            min(2.0 + 7 * 0.75, config.window_growth_cap),
            places=5,
        )
        # 26 forecasts / 40 steps ~= 2.9x transformer-pass skipping
        self.assertEqual(state.forecast_count, 26)

    def test_max_consecutive_cap_binds(self) -> None:
        config = SpectrumConfig(
            warmup_steps=0,
            tail_actual_steps=0,
            window_size=16.0,
            flex_window=0.0,
            max_consecutive_forecasts=1,
        )
        decisions, _ = self._simulate(config, total_steps=12)
        pattern = [a for a, _ in decisions]
        self.assertEqual(pattern.count(False), pattern.count(True))
        self.assertFalse(pattern[0])
        self.assertTrue(pattern[1])

    def test_history_missing_forces_actual(self) -> None:
        config = SpectrumConfig(warmup_steps=0, tail_actual_steps=0, window_size=2.0)
        state = SpectrumBranchState(config=config)  # forecaster not ready
        actual, reason = decide_actual_or_forecast(
            state=state, step_index=0, total_steps=10,
            control_present=False, config=config,
        )
        self.assertTrue(actual)
        self.assertEqual(reason, "insufficient_history")

    def test_control_guard(self) -> None:
        config = SpectrumConfig()
        state = _ready_branch(config)
        actual, reason = decide_actual_or_forecast(
            state=state, step_index=10, total_steps=20,
            control_present=True, config=config,
        )
        self.assertTrue(actual)
        self.assertEqual(reason, "control")

    def test_tail_protects_final_steps(self) -> None:
        config = SpectrumConfig(warmup_steps=0, tail_actual_steps=3)
        state = _ready_branch(config)
        for step in (7, 8, 9):
            actual, reason = decide_actual_or_forecast(
                state=state, step_index=step, total_steps=10,
                control_present=False, config=config,
            )
            self.assertTrue(actual)
            self.assertEqual(reason, "tail")

    def test_unknown_step_is_actual(self) -> None:
        config = SpectrumConfig()
        state = SpectrumBranchState(config=config)
        actual, _ = decide_actual_or_forecast(
            state=state, step_index=-1, total_steps=10,
            control_present=False, config=config,
        )
        self.assertTrue(actual)


class ConfigValidationTest(unittest.TestCase):
    def test_defaults(self) -> None:
        config = SpectrumConfig()
        config.validate()
        self.assertEqual(config.warmup_steps, 5)
        self.assertEqual(config.tail_actual_steps, 2)
        self.assertEqual(config.window_size, 2.0)
        self.assertEqual(config.flex_window, 0.75)
        self.assertEqual(config.max_consecutive_forecasts, 8)
        self.assertEqual(config.history_points, 8)
        self.assertEqual(config.chebyshev_degree, 4)
        self.assertEqual(config.ridge_lambda, 0.1)
        self.assertEqual(config.blend_weight, 0.5)
        self.assertEqual(config.cache_device, "main_device")
        self.assertTrue(config.force_actual_on_control)
        self.assertFalse(config.debug)

    def test_rejects_degree_larger_than_history(self) -> None:
        config = SpectrumConfig(chebyshev_degree=5, history_points=5)
        with self.assertRaises(ValueError):
            config.validate()

    def test_rejects_bad_values(self) -> None:
        with self.assertRaises(ValueError):
            SpectrumConfig(warmup_steps=-1).validate()
        with self.assertRaises(ValueError):
            SpectrumConfig(blend_weight=1.5).validate()
        with self.assertRaises(ValueError):
            SpectrumConfig(window_size=0.5).validate()
        with self.assertRaises(ValueError):
            SpectrumConfig(cache_device="gpu").validate()

    def test_window_growth_cap(self) -> None:
        config = SpectrumConfig()
        self.assertEqual(config.window_growth_cap, 8.0)
        config = SpectrumConfig(window_size=12.0, history_points=4)
        self.assertEqual(config.window_growth_cap, 12.0)


# ===========================================================================
# test_integration.py (ported from upstream tests/, harness adapted)
# ===========================================================================

"""End-to-end test of the Spectrum wrapper against a fake Qwen-Image-2.1.

Runs a simulated sampling loop over the fake transformer replica from
``fake_model.py`` and verifies:

* per-step outputs of the patched model stay close to the unpatched model,
* the schedule matches the controller's expectations (real-forward count
  observed through a norm_out call counter),
* the run-completion bookkeeping and new-run reset work,
* forecast failures degrade to real forwards,
* non-Qwen-Image-2.1 cores pass through untouched,
* determinism (two identical runs give identical results).
"""


import sys
import unittest
from pathlib import Path

import torch


from nodes.spectrum_qwen21.config import SpectrumConfig  # noqa: E402
from nodes.spectrum_qwen21.patcher import create_spectrum_wrapper  # noqa: E402


def _make_options(sigmas: torch.Tensor, with_wrapper=None) -> dict:
    options = {
        "sample_sigmas": sigmas,
        "cond_or_uncond": [0],
        "sigmas": sigmas,
    }
    if with_wrapper is not None:
        options["wrappers"] = {
            "diffusion_model": {"spectrum_qwen21": [with_wrapper]}
        }
    return options


class SpectrumWrapperIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.model = FakeQwenImage21Model(seed=0)
        self.model.eval()
        self.config = SpectrumConfig()
        self.wrapper = create_spectrum_wrapper(self.config)
        self.root = self.wrapper.root_state

        self.steps = 20
        self.sigmas = torch.linspace(1.0, 0.0, self.steps + 1)
        self.context = torch.randn(1, self.model.txt_len, 16)
        self.x0 = torch.randn(1, self.model.in_channels, 8, 8)

        # Count real block-stack executions (the forecast head never runs
        # transformer_blocks, unlike norm_out which both paths execute).
        self.norm_calls = 0

        def counter(module, args):
            self.norm_calls += 1

        self._handle = self.model.transformer_blocks[0].register_forward_pre_hook(counter)

    def tearDown(self) -> None:
        self._handle.remove()

    def _run(self, x: torch.Tensor, options: dict):
        outputs = []
        current = x.clone()
        for i in range(self.steps):
            t = self.sigmas[i].reshape(1)
            out = self.model(
                current, t, self.context, transformer_options=options
            )
            outputs.append(out)
            # arbitrary but stable latent update
            current = current + 0.05 * out
        return outputs, current

    def test_forecast_outputs_stay_close_to_real_outputs(self) -> None:
        real_outputs, _ = self._run(self.x0, _make_options(self.sigmas))
        real_calls = self.norm_calls
        self.assertEqual(real_calls, self.steps)

        self.norm_calls = 0
        patched_outputs, _ = self._run(
            self.x0, _make_options(self.sigmas, self.wrapper)
        )

        # Schedule check: warmup 5 + window actuals + tail 2 for 20 steps.
        # Simulate the controller expectation for 20 steps:
        expected_actual = self._simulate_schedule(self.steps)
        self.assertEqual(self.norm_calls, expected_actual)
        self.assertLess(self.norm_calls, self.steps)

        max_rel = 0.0
        for i, (real, patched) in enumerate(zip(real_outputs, patched_outputs)):
            self.assertEqual(patched.shape, real.shape)
            self.assertTrue(torch.isfinite(patched).all())
            if i >= self.config.warmup_steps:
                rel = (
                    (patched - real).norm() / (real.norm() + 1e-8)
                ).item()
                max_rel = max(max_rel, rel)
        # forecast steps must stay within a few percent of the real output
        self.assertLess(max_rel, 0.05, f"max relative error too high: {max_rel}")

    def _simulate_schedule(self, total: int) -> int:
        from nodes.spectrum_qwen21.controller import (
            decide_actual_or_forecast,
            note_decision,
        )
        from nodes.spectrum_qwen21.state import SpectrumBranchState

        state = SpectrumBranchState(config=self.config)
        forecaster = state.forecaster
        forecaster._feature_shape = torch.Size((1, 1))
        forecaster._feature_dtype = torch.float32
        forecaster._storage_device = torch.device("cpu")
        from nodes.spectrum_qwen21.chebyshev import _Anchor

        count = 0
        recorded = 0
        for step in range(total):
            # mimic anchors recorded on real steps
            if recorded < self.config.chebyshev_degree + 1:
                forecaster._anchors.append(_Anchor(0.0, torch.zeros(1, 1)))
                recorded += 1
            actual, reason = decide_actual_or_forecast(
                state=state, step_index=step, total_steps=total,
                control_present=False, config=self.config,
            )
            note_decision(state, actual, reason, self.config)
            if actual:
                count += 1
                if recorded < self.config.history_points:
                    forecaster._anchors.append(_Anchor(0.0, torch.zeros(1, 1)))
                    recorded += 1
        return count

    def test_determinism(self) -> None:
        out_a, _ = self._run(self.x0, _make_options(self.sigmas, self.wrapper))
        wrapper_b = create_spectrum_wrapper(self.config)
        out_b, _ = self._run(self.x0, _make_options(self.sigmas, wrapper_b))
        for a, b in zip(out_a, out_b):
            self.assertTrue(torch.equal(a, b))

    def test_new_run_resets_state(self) -> None:
        self._run(self.x0, _make_options(self.sigmas, self.wrapper))
        first_branch = self.root.branch_states.get((0,))
        self.assertIsNotNone(first_branch)
        self.assertGreater(first_branch.actual_count, 0)

        # a new sigma tensor (new run) must reset the branch state
        new_sigmas = torch.linspace(0.9, 0.0, 15)
        self.norm_calls = 0
        self._run(self.x0, _make_options(new_sigmas, self.wrapper))
        second_branch = self.root.branch_states.get((0,))
        self.assertIsNotNone(second_branch)
        self.assertEqual(len(self.root.branch_states), 1)
        # history was released at the end of the first run
        self.assertEqual(first_branch.forecaster.history_size, 0)

    def test_forecast_failure_degrades_to_real(self) -> None:
        from unittest.mock import patch

        from nodes.spectrum_qwen21.chebyshev import HistoryWeightChebyshevForecaster

        def broken_predict(self, coord):
            raise RuntimeError("boom")

        self.norm_calls = 0
        with patch.object(
            HistoryWeightChebyshevForecaster, "predict", broken_predict
        ):
            outputs, _ = self._run(
                self.x0, _make_options(self.sigmas, self.wrapper)
            )
        # every forecast attempt degraded to a real forward
        self.assertEqual(self.norm_calls, self.steps)
        for out in outputs:
            self.assertEqual(tuple(out.shape), (1, self.model.out_channels, 8, 8))
            self.assertTrue(torch.isfinite(out).all())
        branch = self.root.branch_states.get((0,))
        self.assertIsNotNone(branch)
        self.assertEqual(branch.actual_count, self.steps)
        self.assertEqual(branch.forecast_count, 0)

    def test_control_present_forces_real(self) -> None:
        config = SpectrumConfig()
        wrapper = create_spectrum_wrapper(config)
        x = self.x0
        calls = 0

        def counter(module, args):
            nonlocal calls
            calls += 1

        handle = self.model.transformer_blocks[0].register_forward_pre_hook(counter)
        try:
            for i in range(self.steps):
                t = self.sigmas[i].reshape(1)
                opts = _make_options(self.sigmas, wrapper)
                opts["cond_or_uncond"] = [0]
                out = self.model(
                    x, t, self.context, transformer_options=opts, control=object()
                )
                x = x + 0.05 * out
        finally:
            handle.remove()
        self.assertEqual(calls, self.steps)

    def test_non_qwen_model_passthrough(self) -> None:
        # feed the wrapper a model object that fails the structural check
        model = NotAQwenModel()

        captured = {}

        def executor(*args, **kwargs):
            captured["args"] = (args, kwargs)
            return model(args[0])

        wrapper = create_spectrum_wrapper(SpectrumConfig())
        opts = _make_options(self.sigmas, wrapper)
        opts["wrappers"]["diffusion_model"]["spectrum_qwen21"] = [wrapper]

        x = torch.randn(2, 4)
        out = FakeExecutor(model.forward, model, [wrapper]).execute(
            x, self.sigmas[0].reshape(1), None, None, None, opts
        )
        self.assertTrue(torch.equal(out, model(x)))
        # the model never became qwen-detected: branch state stays empty
        self.assertEqual(len(wrapper.root_state.branch_states), 0)

    def test_missing_sample_sigmas_runs_real(self) -> None:
        self.norm_calls = 0
        options = {"cond_or_uncond": [0]}
        for i in range(3):
            t = self.sigmas[i].reshape(1)
            self.model(
                self.x0, t, self.context, transformer_options={
                    **options, "wrappers": {"diffusion_model": {"spectrum_qwen21": [self.wrapper]}}
                }
            )
        self.assertEqual(self.norm_calls, 3)

    def test_debug_mode_runs_without_error(self) -> None:
        config = SpectrumConfig(debug=True)
        wrapper = create_spectrum_wrapper(config)
        outputs, _ = self._run(self.x0, _make_options(self.sigmas, wrapper))
        self.assertEqual(len(outputs), self.steps)


# ===========================================================================
# test_patcher.py (ported from upstream tests/, harness adapted)
# ===========================================================================

"""Tests for apply_spectrum registration via stubbed comfy modules."""


import importlib
import importlib.util
import sys
import types
import unittest
from pathlib import Path

import torch



def _load_node_package():
    """Return the vendored Spectrum node definition (repo-adapted harness)."""
    from nodes.spectrum_qwen21 import node_def

    return node_def


class _StubModelPatcher:
    """Minimal ModelPatcher stand-in."""

    def __init__(self, core):
        self.core = core
        self.model_options = {}

    def clone(self, *args, **kwargs):
        clone = _StubModelPatcher(self.core)
        # ComfyUI clones carry over model_options
        clone.model_options = {
            "transformer_options": {
                k: v for k, v in self.model_options.get("transformer_options", {}).items()
            }
        }
        return clone

    def get_model_object(self, name):
        return self.core


def _install_comfy_stubs() -> None:
    comfy = sys.modules.setdefault("comfy", types.ModuleType("comfy"))
    patcher_extension = sys.modules.setdefault(
        "comfy.patcher_extension", types.ModuleType("comfy.patcher_extension")
    )

    class WrappersMP:
        DIFFUSION_MODEL = "diffusion_model"
        APPLY_MODEL = "apply_model"

    def add_wrapper_with_key(wrapper_type, key, wrapper, options, is_model_options=False):
        if is_model_options:
            options = options.setdefault("transformer_options", {})
        wrappers = options.setdefault("wrappers", {})
        wrappers.setdefault(wrapper_type, {}).setdefault(key, []).append(wrapper)

    patcher_extension.WrappersMP = WrappersMP  # type: ignore[attr-defined]
    patcher_extension.add_wrapper_with_key = add_wrapper_with_key  # type: ignore[attr-defined]
    comfy.patcher_extension = patcher_extension  # type: ignore[attr-defined]



class ApplySpectrumTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _install_comfy_stubs()

    def test_registers_wrapper_on_clone_only(self) -> None:
        from nodes.spectrum_qwen21.config import SpectrumConfig
        from nodes.spectrum_qwen21.constants import WRAPPER_KEY
        from nodes.spectrum_qwen21.patcher import apply_spectrum

        core = FakeQwenImage21Model()
        patcher = _StubModelPatcher(core)
        patcher.model_options["transformer_options"] = {"existing": True}

        patched = apply_spectrum(patcher, SpectrumConfig())

        self.assertIsNot(patched, patcher)
        wrappers = (
            patched.model_options["transformer_options"]
            .get("wrappers", {})
            .get("diffusion_model", {})
            .get(WRAPPER_KEY)
        )
        self.assertIsNotNone(wrappers)
        self.assertEqual(len(wrappers), 1)
        self.assertTrue(callable(wrappers[0]))

        # original patcher untouched
        self.assertNotIn(
            "wrappers", patcher.model_options.get("transformer_options", {})
        )
        # unrelated transformer_options survive the clone
        self.assertTrue(
            patched.model_options["transformer_options"].get("existing")
        )

    def test_rejects_non_qwen21_model(self) -> None:
        from nodes.spectrum_qwen21.config import SpectrumConfig
        from nodes.spectrum_qwen21.patcher import apply_spectrum

        class OldQwen:
            # Qwen-Image 1.x exposes txt_norm; must be rejected
            txt_norm = None
            txt_in = None
            img_in = None
            transformer_blocks = [object()]
            norm_out = None
            proj_out = None
            time_text_embed = None
            inner_dim = 8
            out_channels = 8

        patcher = _StubModelPatcher(OldQwen())
        with self.assertRaises(ValueError):
            apply_spectrum(patcher, SpectrumConfig())

    def test_config_validated_before_patch(self) -> None:
        from nodes.spectrum_qwen21.config import SpectrumConfig
        from nodes.spectrum_qwen21.patcher import apply_spectrum

        core = FakeQwenImage21Model()
        patcher = _StubModelPatcher(core)
        bad = SpectrumConfig(chebyshev_degree=9, history_points=4)
        with self.assertRaises(ValueError):
            apply_spectrum(patcher, bad)


class NodeDefinitionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _install_comfy_stubs()

    def test_node_mappings_importable(self) -> None:
        pkg = _load_node_package()
        nodes = _load_node_package()

        self.assertIn("SpectrumQwenImage21", nodes.NODE_CLASS_MAPPINGS)
        self.assertIn("SpectrumQwenImage21", nodes.NODE_DISPLAY_NAME_MAPPINGS)
        self.assertEqual(
            nodes.NODE_DISPLAY_NAME_MAPPINGS["SpectrumQwenImage21"],
            "Spectrum (Qwen-Image-2.1)",
        )

    def test_input_types_defaults(self) -> None:
        _load_node_package()
        nodes = _load_node_package()
        SpectrumQwenImage21 = nodes.SpectrumQwenImage21

        spec = SpectrumQwenImage21.INPUT_TYPES()
        required = spec["required"]
        self.assertIn("model", required)
        defaults = {
            "warmup_steps": 5,
            "tail_actual_steps": 2,
            "window_size": 2.0,
            "flex_window": 0.75,
            "max_consecutive_forecasts": 8,
            "history_points": 8,
            "chebyshev_degree": 4,
            "ridge_lambda": 0.1,
            "blend_weight": 0.5,
            "cache_device": "main_device",
            "force_actual_on_control": True,
            "debug": False,
        }
        for key, value in defaults.items():
            self.assertIn(key, required, f"missing input: {key}")
            self.assertEqual(required[key][1]["default"], value, f"bad default: {key}")
        # return signature
        self.assertEqual(SpectrumQwenImage21.RETURN_TYPES, ("MODEL",))
        self.assertEqual(SpectrumQwenImage21.FUNCTION, "patch")

    def test_patch_returns_model_tuple(self) -> None:
        _load_node_package()
        nodes = _load_node_package()
        SpectrumQwenImage21 = nodes.SpectrumQwenImage21

        core = FakeQwenImage21Model()
        patcher = _StubModelPatcher(core)
        node = SpectrumQwenImage21()
        result = node.patch(
            model=patcher,
            warmup_steps=5,
            tail_actual_steps=2,
            window_size=2.0,
            flex_window=0.75,
            max_consecutive_forecasts=8,
            history_points=8,
            chebyshev_degree=4,
            ridge_lambda=0.1,
            blend_weight=0.5,
            cache_device="main_device",
            force_actual_on_control=True,
            debug=False,
        )
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], _StubModelPatcher)

if __name__ == "__main__":
    unittest.main()
