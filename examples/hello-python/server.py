# hello-python — the deliberately-FOREIGN consumer (0.4 generality gate):
# different runtime (CPython, stdlib-only), same broker verbs. If the manifest
# model only fit Node apps, this example is where it would show.
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8000"))
DB_PATH = os.environ.get("DB_PATH", "./hello.db")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep service logs meaningful
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json({"ok": True, "runtime": "python"})
        if self.path == "/api/facts":
            con = sqlite3.connect(DB_PATH)
            rows = [{"id": r[0], "fact": r[1]} for r in con.execute("SELECT id, fact FROM facts ORDER BY id")]
            con.close()
            return self._json(rows)
        return self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    print(f"hello-python listening on :{PORT} (db: {DB_PATH})", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
