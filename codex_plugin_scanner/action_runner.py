"""Run the installed scanner with UTF-8 output on every supported platform."""

from pathlib import Path
import runpy
import sys

from codex_plugin_scanner import __path__ as package_paths


def _use_utf8(stream: object) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


def _installed_runner() -> Path:
    this_file = Path(__file__).resolve()
    for package_path in package_paths:
        candidate = Path(package_path, "action_runner.py").resolve()
        if candidate != this_file and candidate.is_file():
            return candidate
    raise RuntimeError("The installed codex-plugin-scanner action runner was not found")


_use_utf8(sys.stdout)
_use_utf8(sys.stderr)
runpy.run_path(str(_installed_runner()), run_name="__main__")
