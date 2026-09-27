"""Cache headers for the extension's web files.

ComfyUI serves ``web/`` at ``/extensions/<folder>/`` and marks only ``.js``/``.css`` as
``no-store``; ``.mjs`` modules (most of UniCanvas, Pose Studio and 3D Factory) get no
``Cache-Control`` at all, so browsers cache them heuristically and keep running old code
after an update. This middleware marks every file of this extension ``no-cache``: the
browser revalidates on each page load (a cheap 304 via ETag/Last-Modified) and always
picks up changed files, without version queries in the imports.
"""

from __future__ import annotations

import os

WEB_CACHE_CONTROL = "no-cache"


def extension_web_prefix(extension_dir: str) -> str:
    # ComfyUI registers WEB_DIRECTORY under the extension folder's basename.
    return f"/extensions/{os.path.basename(os.path.normpath(extension_dir))}/"


def make_web_cache_middleware(prefix: str):
    from aiohttp import web

    @web.middleware
    async def vnccs_web_cache_control(request, handler):
        response = await handler(request)
        if request.path.startswith(prefix):
            # Set here, inside ComfyUI's own cache middleware, whose setdefault keeps it.
            response.headers["Cache-Control"] = WEB_CACHE_CONTROL
        return response

    return vnccs_web_cache_control


def register_web_cache_middleware(app, extension_dir: str) -> bool:
    """Append the middleware to the ComfyUI app; False when the app is already running."""
    middleware = make_web_cache_middleware(extension_web_prefix(extension_dir))
    try:
        app.middlewares.append(middleware)
    except (AttributeError, RuntimeError):
        # aiohttp freezes the middleware list once the app starts.
        return False
    return True
