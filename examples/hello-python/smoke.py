# The smoke check: stdlib-only vertical proof. Exit code = the verdict.
import json
import os
import sys
import urllib.request

base = os.environ.get("BASE_URL")
if not base:
    print("BASE_URL not set — run through `infront run smoke`", file=sys.stderr)
    sys.exit(2)

health = json.load(urllib.request.urlopen(f"{base}/health"))
assert health["ok"], health

facts = json.load(urllib.request.urlopen(f"{base}/api/facts"))
assert isinstance(facts, list) and len(facts) > 0, facts

print(f"smoke ok — {len(facts)} facts served from the seeded db (runtime: {health['runtime']})")
