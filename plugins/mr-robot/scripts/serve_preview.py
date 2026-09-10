#!/usr/bin/env python3
"""Serve a saved page locally with caching disabled."""

from __future__ import annotations

import argparse
import functools
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit


class PreviewHandler(SimpleHTTPRequestHandler):
    index_name = "index.html"
    spa = False

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/" and self.index_name != "index.html":
            self.path = "/" + quote(self.index_name)
        elif self.spa:
            local_path = Path(self.translate_path(self.path))
            if not local_path.exists() and "." not in Path(path).name:
                self.path = "/" + quote(self.index_name)
        super().do_GET()

    def log_message(self, message: str, *args) -> None:
        print(f"preview: {message % args}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="source directory or one HTML file")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--spa", action="store_true")
    parser.add_argument("--once", action="store_true", help="serve one request and exit")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    if source.is_file():
        if source.suffix.lower() not in {".htm", ".html"}:
            print("error: a single-file preview must be HTML", file=sys.stderr)
            return 1
        root = source.parent
        index_name = source.name
    elif source.is_dir():
        root = source
        index_name = "index.html"
        if not (root / index_name).is_file():
            print("error: source directory must contain index.html", file=sys.stderr)
            return 1
    else:
        print(f"error: source does not exist: {source}", file=sys.stderr)
        return 1

    handler = functools.partial(PreviewHandler, directory=str(root))
    PreviewHandler.index_name = index_name
    PreviewHandler.spa = args.spa

    try:
        # A one-shot request must finish before the process closes its socket.
        server_class = HTTPServer if args.once else ThreadingHTTPServer
        server = server_class((args.host, args.port), handler)
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    host, port = server.server_address[:2]
    print(f"Previewing {source} at http://{host}:{port}/", flush=True)
    try:
        if args.once:
            server.handle_request()
        else:
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
