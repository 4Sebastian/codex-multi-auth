"""Run the installed scanner with UTF-8 output on every supported platform."""

from pathlib import Path
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
runner_path = _installed_runner()
runner_globals = {
    "__file__": str(runner_path),
    "__name__": "__main__",
    "__package__": "codex_plugin_scanner",
}
exec(compile(runner_path.read_bytes(), str(runner_path), "exec"), runner_globals)
