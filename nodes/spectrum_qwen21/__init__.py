# Ported from Comfyui-Spectrum-Qwen2.1 - https://github.com/awdqwdasdg/Comfyui-Spectrum-Qwen2.1
# Copyright (c) 2026 ComfyUI-Spectrum-QwenImage21 contributors.
# Licensed under the MIT License; see the MIT attribution in README.md.
# Spectrum acceleration (arXiv 2603.01623) for Qwen-Image-2.1, vendored for VNCCS UniCanvas.
from .config import SpectrumConfig
from .patcher import apply_spectrum, create_spectrum_wrapper

__all__ = ["SpectrumConfig", "apply_spectrum", "create_spectrum_wrapper"]
