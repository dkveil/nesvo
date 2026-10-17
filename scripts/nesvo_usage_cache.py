"""Cache only Claude subscription windows for Nesvo; no credentials or prompts."""
import json
import os
import tempfile
import time
from pathlib import Path


def cache_usage(data):
    limits = data.get("rate_limits")
    if not isinstance(limits, dict):
        return
    windows = {}
    for key in ("five_hour", "seven_day"):
        value = limits.get(key)
        if not isinstance(value, dict):
            continue
        used, reset = value.get("used_percentage"), value.get("resets_at")
        if type(used) in (int, float) and 0 <= used <= 100 and type(reset) in (int, float) and reset > time.time():
            windows[key] = {"used_percentage": used, "resets_at": int(reset)}
    if not windows:
        return
    directory = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as output:
            temporary = output.name
            json.dump({"at": int(time.time()), "rate_limits": windows}, output)
        os.replace(temporary, directory / ".rate-limits.json")
    except OSError:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass
