#!/usr/bin/env python3
"""Package a small static site as a self-contained Cloudflare Worker."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path


SKIP_DIRECTORIES = {".git", ".mr-robot", "__pycache__", "dist", "node_modules"}
TEXT_TYPES = {
    ".css": "text/css; charset=UTF-8",
    ".csv": "text/csv; charset=UTF-8",
    ".html": "text/html; charset=UTF-8",
    ".htm": "text/html; charset=UTF-8",
    ".js": "text/javascript; charset=UTF-8",
    ".json": "application/json; charset=UTF-8",
    ".map": "application/json; charset=UTF-8",
    ".md": "text/markdown; charset=UTF-8",
    ".mjs": "text/javascript; charset=UTF-8",
    ".svg": "image/svg+xml; charset=UTF-8",
    ".txt": "text/plain; charset=UTF-8",
    ".xml": "application/xml; charset=UTF-8",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def worker_name(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.strip().lower()).strip("-")
    normalized = re.sub(r"-+", "-", normalized)
    if not normalized:
        raise ValueError("worker name must contain a letter or number")
    return normalized[:63].rstrip("-")


def media_type(path: Path) -> str:
    explicit = TEXT_TYPES.get(path.suffix.lower())
    if explicit:
        return explicit
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def collect(source: Path, maximum_bytes: int) -> tuple[dict[str, dict[str, str]], int, str]:
    if source.is_symlink():
        raise ValueError(f"symbolic links are not supported: {source}")
    if source.is_file():
        if source.suffix.lower() not in {".htm", ".html"}:
            raise ValueError("a single-file source must be an HTML file")
        candidates = [(source, Path("index.html"))]
    elif source.is_dir():
        candidates = []
        for current, directory_names, file_names in os.walk(source, followlinks=False):
            current_path = Path(current)
            kept_directories = []
            for name in directory_names:
                child = current_path / name
                if name in SKIP_DIRECTORIES:
                    continue
                if child.is_symlink():
                    raise ValueError(f"symbolic links are not supported: {child}")
                kept_directories.append(name)
            directory_names[:] = kept_directories
            for name in sorted(file_names):
                file_path = current_path / name
                if file_path.is_symlink():
                    raise ValueError(f"symbolic links are not supported: {file_path}")
                candidates.append((file_path, file_path.relative_to(source)))
    else:
        raise ValueError(f"source does not exist: {source}")

    records: dict[str, dict[str, str]] = {}
    total_bytes = 0
    digest = hashlib.sha256()
    for file_path, relative in sorted(candidates, key=lambda item: item[1].as_posix()):
        data = file_path.read_bytes()
        total_bytes += len(data)
        if total_bytes > maximum_bytes:
            raise ValueError(f"source exceeds --max-bytes ({maximum_bytes})")
        relative_name = relative.as_posix()
        route = "/" + relative_name
        digest.update(relative_name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        records[route] = {
            "body": base64.b64encode(data).decode("ascii"),
            "type": media_type(relative),
        }

    if "/index.html" not in records:
        raise ValueError("source directory must contain index.html")
    return records, total_bytes, digest.hexdigest()


def render_worker(records: dict[str, dict[str, str]], spa: bool) -> str:
    encoded_records = json.dumps(records, ensure_ascii=True, separators=(",", ":"))
    spa_literal = "true" if spa else "false"
    return f'''const files = {encoded_records};
const spaFallback = {spa_literal};

function decodeBase64(value) {{
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}}

export default {{
  async fetch(request) {{
    if (request.method !== "GET" && request.method !== "HEAD") {{
      return new Response("Method Not Allowed", {{ status: 405, headers: {{ allow: "GET, HEAD" }} }});
    }}

    let path;
    try {{
      path = decodeURIComponent(new URL(request.url).pathname);
    }} catch {{
      return new Response("Bad Request", {{ status: 400 }});
    }}
    if (path.endsWith("/")) path += "index.html";

    const asset = files[path] || (spaFallback ? files["/index.html"] : undefined);
    if (!asset) return new Response("Not Found", {{ status: 404 }});

    return new Response(request.method === "HEAD" ? null : decodeBase64(asset.body), {{
      headers: {{
        "content-type": asset.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }}
    }});
  }}
}};
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="source directory or one HTML file")
    parser.add_argument("--output", required=True, help="directory for worker.mjs and metadata")
    parser.add_argument("--name", required=True, help="Cloudflare Worker name")
    parser.add_argument("--spa", action="store_true", help="serve index.html for unknown routes")
    parser.add_argument("--max-bytes", type=int, default=2_000_000)
    args = parser.parse_args()

    try:
        source = Path(args.source).expanduser().resolve()
        output = Path(args.output).expanduser().resolve()
        name = worker_name(args.name)
        records, total_bytes, source_hash = collect(source, args.max_bytes)
        output.mkdir(parents=True, exist_ok=True)

        worker_path = output / "worker.mjs"
        worker_path.write_text(render_worker(records, args.spa), encoding="utf-8", newline="\n")
        wrangler = {
            "$schema": "node_modules/wrangler/config-schema.json",
            "name": name,
            "main": "./worker.mjs",
            "compatibility_date": date.today().isoformat(),
            "workers_dev": True,
        }
        (output / "wrangler.jsonc").write_text(json.dumps(wrangler, indent=2) + "\n", encoding="utf-8")
        manifest = {
            "schemaVersion": 1,
            "name": name,
            "builtAt": utc_now(),
            "source": str(source),
            "sourceHash": source_hash,
            "spa": args.spa,
            "totalBytes": total_bytes,
            "files": sorted(path.removeprefix("/") for path in records),
            "worker": str(worker_path),
        }
        (output / "build-manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
        return 0
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
