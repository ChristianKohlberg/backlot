# The smoke test: stdlib-only vertical proof. Exit code = the verdict.
#   eval "$(runly ctx --env)" && python3 smoke.py
import json
import os
import sys
import urllib.request

base = os.environ.get("RUNLY_URL_WEB") or os.environ.get("BASE_URL")
if not base:
    print('RUNLY_URL_WEB not set — run: eval "$(runly ctx --env)" && python3 smoke.py', file=sys.stderr)
    sys.exit(2)

health = json.load(urllib.request.urlopen(f"{base}/health"))
assert health["ok"], health

facts = json.load(urllib.request.urlopen(f"{base}/api/facts"))
assert isinstance(facts, list) and len(facts) > 0, facts

print(f"smoke ok — {len(facts)} facts served from the seeded db (runtime: {health['runtime']})")
