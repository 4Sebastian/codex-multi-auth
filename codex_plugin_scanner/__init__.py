"""Compatibility package for the Codex plugin scanner GitHub Action."""

from pkgutil import extend_path
from importlib.metadata import PackageNotFoundError, version

__path__ = extend_path(__path__, __name__)
try:
    __version__ = version("codex-plugin-scanner")
except PackageNotFoundError:
    __version__ = "unknown"
