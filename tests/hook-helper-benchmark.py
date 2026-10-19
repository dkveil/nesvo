"""Measure the real helper process without starting an agent or model request."""
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

binary = Path(sys.argv[1]).resolve(strict=True)
samples = []
with tempfile.TemporaryDirectory(prefix="nesvo-hook-cost-") as directory:
    report = Path(directory) / "context.json"
    for attempt in range(23):
        started = time.perf_counter()
        completed = subprocess.run(
            [str(binary), "--agent-context-hook", str(report)],
            input=b'{"hook_event_name":"SessionStart"}',
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            timeout=5,
        )
        completed.check_returncode()
        if attempt >= 3:
            samples.append((time.perf_counter() - started) * 1000)
print(json.dumps({
    "samples": len(samples),
    "medianMs": statistics.median(samples),
    "p95Ms": sorted(samples)[18],
    "includesProcessStartup": True,
    "modelRequests": 0,
}))
