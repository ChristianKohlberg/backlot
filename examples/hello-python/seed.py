# Seed for hello-python: python3 seed.py <db-path> <preset>
import sqlite3
import sys

db_path = sys.argv[1] if len(sys.argv) > 1 else "./hello.db"
preset = sys.argv[2] if len(sys.argv) > 2 else "dev"

presets = {
    "dev": ["snakes have no eyelids", "python 1.0 shipped in 1994", "the GIL is (mostly) gone"],
    "empty": [],
}
if preset not in presets:
    print(f"unknown preset '{preset}'", file=sys.stderr)
    sys.exit(1)

con = sqlite3.connect(db_path)
con.execute("DROP TABLE IF EXISTS facts")
con.execute("CREATE TABLE facts (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)")
con.executemany("INSERT INTO facts (fact) VALUES (?)", [(f,) for f in presets[preset]])
con.commit()
con.close()
print(f"seeded {db_path} with preset '{preset}' ({len(presets[preset])} rows)")
