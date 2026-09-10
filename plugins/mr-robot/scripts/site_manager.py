#!/usr/bin/env python3
"""Manage Mr. Robot page sources, revisions, trash, and publication metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
SKIP_DIRECTORIES = {".git", ".mr-robot", "__pycache__", "dist", "node_modules"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise ValueError("site name must contain a letter or number")
    return slug[:63].rstrip("-")


def library_root(value: str | None) -> Path:
    configured = value or os.environ.get("MR_ROBOT_HOME") or str(Path.home() / ".mr-robot")
    return Path(configured).expanduser().resolve()


def ensure_library(root: Path) -> None:
    (root / "sites").mkdir(parents=True, exist_ok=True)
    (root / "trash").mkdir(parents=True, exist_ok=True)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing metadata: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid metadata: {path}") from exc


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def iter_source_files(source: Path):
    if source.is_symlink():
        raise ValueError(f"symbolic links are not supported: {source}")
    if source.is_file():
        yield source, Path("index.html" if source.suffix.lower() in {".htm", ".html"} else source.name)
        return
    if not source.is_dir():
        raise ValueError(f"source does not exist: {source}")

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
            yield file_path, file_path.relative_to(source)


def copy_source(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    copied = 0
    for file_path, relative_path in iter_source_files(source):
        target = destination / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file_path, target)
        copied += 1
    if copied == 0:
        raise ValueError("source contains no files")


def source_summary(source: Path) -> tuple[str, list[str], int]:
    digest = hashlib.sha256()
    files: list[str] = []
    total_bytes = 0
    for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
        relative = file_path.relative_to(source).as_posix()
        data = file_path.read_bytes()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        files.append(relative)
        total_bytes += len(data)
    return digest.hexdigest(), files, total_bytes


def site_directory(root: Path, value: str) -> tuple[str, Path]:
    slug = slugify(value)
    return slug, root / "sites" / slug


def snapshot(site_dir: Path, metadata: dict) -> str | None:
    current = site_dir / "source"
    if not current.exists():
        return None
    source_hash = metadata.get("sourceHash") or source_summary(current)[0]
    revision_name = f"r{int(metadata.get('revision', 0)):04d}-{timestamp()}-{source_hash[:8]}"
    revision_dir = site_dir / "revisions" / revision_name
    revision_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(current, revision_dir)
    return revision_name


def require_site(root: Path, value: str) -> tuple[str, Path, dict]:
    slug, site_dir = site_directory(root, value)
    if not site_dir.is_dir():
        raise ValueError(f"unknown site: {slug}")
    return slug, site_dir, read_json(site_dir / "site.json")


def command_save(args: argparse.Namespace, root: Path) -> None:
    slug, site_dir = site_directory(root, args.site)
    source_input = Path(args.source).expanduser().resolve()
    existing = site_dir.is_dir()
    metadata = read_json(site_dir / "site.json") if existing else {}

    sites_root = root / "sites"
    temporary_root = Path(tempfile.mkdtemp(prefix=f".{slug}-", dir=sites_root))
    staged_source = temporary_root / "source"
    try:
        copy_source(source_input, staged_source)
        source_hash, files, total_bytes = source_summary(staged_source)
        previous_hash = metadata.get("sourceHash")

        if existing and source_hash == previous_hash:
            shutil.rmtree(temporary_root)
            if args.title and args.title != metadata.get("title"):
                metadata["title"] = args.title
                metadata["updatedAt"] = utc_now()
                write_json(site_dir / "site.json", metadata)
            print(json.dumps({"site": slug, "changed": False, "revision": metadata.get("revision")}, indent=2))
            return

        if existing:
            snapshot(site_dir, metadata)
            shutil.rmtree(site_dir / "source")
        else:
            site_dir.mkdir(parents=True)
            (site_dir / "revisions").mkdir()

        shutil.move(str(staged_source), str(site_dir / "source"))
        shutil.rmtree(temporary_root, ignore_errors=True)

        now = utc_now()
        revision = int(metadata.get("revision", 0)) + 1
        next_metadata = {
            "schemaVersion": SCHEMA_VERSION,
            "slug": slug,
            "title": args.title or metadata.get("title") or args.site,
            "createdAt": metadata.get("createdAt") or now,
            "updatedAt": now,
            "revision": revision,
            "sourceHash": source_hash,
            "files": files,
            "totalBytes": total_bytes,
            "publication": metadata.get("publication") or {"status": "draft"},
        }
        write_json(site_dir / "site.json", next_metadata)
        print(json.dumps({"site": slug, "changed": True, **next_metadata}, indent=2, ensure_ascii=False))
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def command_list(args: argparse.Namespace, root: Path) -> None:
    records = []
    for site_dir in sorted((root / "sites").iterdir()):
        if not site_dir.is_dir() or not (site_dir / "site.json").exists():
            continue
        metadata = read_json(site_dir / "site.json")
        records.append(metadata)
    if args.json:
        print(json.dumps(records, indent=2, ensure_ascii=False))
        return
    if not records:
        print("No saved pages.")
        return
    print("SITE\tSTATUS\tREVISION\tUPDATED\tTITLE")
    for record in records:
        status = record.get("publication", {}).get("status", "draft")
        print(f"{record['slug']}\t{status}\t{record['revision']}\t{record['updatedAt']}\t{record['title']}")


def command_show(args: argparse.Namespace, root: Path) -> None:
    _, site_dir, metadata = require_site(root, args.site)
    metadata = {**metadata, "path": str(site_dir), "sourcePath": str(site_dir / "source")}
    print(json.dumps(metadata, indent=2, ensure_ascii=False))


def command_history(args: argparse.Namespace, root: Path) -> None:
    _, site_dir, metadata = require_site(root, args.site)
    revisions_dir = site_dir / "revisions"
    revisions = sorted((path.name for path in revisions_dir.iterdir() if path.is_dir()), reverse=True)
    result = {"site": metadata["slug"], "currentRevision": metadata["revision"], "revisions": revisions}
    print(json.dumps(result, indent=2))


def command_restore_revision(args: argparse.Namespace, root: Path) -> None:
    slug, site_dir, metadata = require_site(root, args.site)
    if Path(args.revision).name != args.revision:
        raise ValueError("revision must be a revision name, not a path")
    revision_dir = site_dir / "revisions" / args.revision
    if not revision_dir.is_dir():
        raise ValueError(f"unknown revision: {args.revision}")

    snapshot(site_dir, metadata)
    replacement = site_dir / f".restore-{timestamp()}"
    shutil.copytree(revision_dir, replacement)
    shutil.rmtree(site_dir / "source")
    replacement.replace(site_dir / "source")

    source_hash, files, total_bytes = source_summary(site_dir / "source")
    metadata.update(
        updatedAt=utc_now(),
        revision=int(metadata.get("revision", 0)) + 1,
        sourceHash=source_hash,
        files=files,
        totalBytes=total_bytes,
    )
    write_json(site_dir / "site.json", metadata)
    print(json.dumps({"site": slug, "restoredFrom": args.revision, "revision": metadata["revision"]}, indent=2))


def command_delete(args: argparse.Namespace, root: Path) -> None:
    slug, site_dir, _ = require_site(root, args.site)
    if not args.yes:
        raise ValueError("soft deletion requires --yes")
    entry = f"{slug}--{timestamp()}"
    destination = root / "trash" / entry
    shutil.move(str(site_dir), str(destination))
    print(json.dumps({"site": slug, "deleted": True, "trashEntry": entry}, indent=2))


def command_restore(args: argparse.Namespace, root: Path) -> None:
    slug, active_site = site_directory(root, args.site)
    if active_site.exists():
        raise ValueError(f"site already exists: {slug}")
    trash_root = root / "trash"
    if args.entry:
        if Path(args.entry).name != args.entry or not args.entry.startswith(slug + "--"):
            raise ValueError("trash entry does not match the site")
        candidates = [trash_root / args.entry]
    else:
        candidates = sorted(trash_root.glob(slug + "--*"), reverse=True)
    source = next((path for path in candidates if path.is_dir()), None)
    if source is None:
        raise ValueError(f"no deleted copy found for: {slug}")
    shutil.move(str(source), str(active_site))
    print(json.dumps({"site": slug, "restored": True, "from": source.name}, indent=2))


def command_mark_published(args: argparse.Namespace, root: Path) -> None:
    slug, site_dir, metadata = require_site(root, args.site)
    parsed = urlsplit(args.url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("published URL must be an absolute HTTPS URL")
    metadata["publication"] = {
        "status": "published",
        "provider": args.provider,
        "url": args.url,
        "deployment": args.deployment,
        "updatedAt": utc_now(),
    }
    write_json(site_dir / "site.json", metadata)
    print(json.dumps({"site": slug, "publication": metadata["publication"]}, indent=2))


def command_mark_offline(args: argparse.Namespace, root: Path) -> None:
    slug, site_dir, metadata = require_site(root, args.site)
    publication = metadata.get("publication") or {}
    publication.update(status="offline", updatedAt=utc_now())
    metadata["publication"] = publication
    write_json(site_dir / "site.json", metadata)
    print(json.dumps({"site": slug, "publication": publication}, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="page library root (default: MR_ROBOT_HOME or ~/.mr-robot)")
    commands = parser.add_subparsers(dest="command", required=True)

    save = commands.add_parser("save", help="create or update a saved page")
    save.add_argument("site")
    save.add_argument("source")
    save.add_argument("--title")
    save.set_defaults(handler=command_save)

    list_command = commands.add_parser("list", help="list active pages")
    list_command.add_argument("--json", action="store_true")
    list_command.set_defaults(handler=command_list)

    show = commands.add_parser("show", help="show page metadata")
    show.add_argument("site")
    show.set_defaults(handler=command_show)

    history = commands.add_parser("history", help="list source revisions")
    history.add_argument("site")
    history.set_defaults(handler=command_history)

    restore_revision = commands.add_parser("restore-revision", help="replace source with a saved revision")
    restore_revision.add_argument("site")
    restore_revision.add_argument("revision")
    restore_revision.set_defaults(handler=command_restore_revision)

    delete = commands.add_parser("delete", help="move a page to trash")
    delete.add_argument("site")
    delete.add_argument("--yes", action="store_true")
    delete.set_defaults(handler=command_delete)

    restore = commands.add_parser("restore", help="restore the newest deleted copy")
    restore.add_argument("site")
    restore.add_argument("--entry")
    restore.set_defaults(handler=command_restore)

    published = commands.add_parser("mark-published", help="record a successful publication")
    published.add_argument("site")
    published.add_argument("--provider", required=True)
    published.add_argument("--url", required=True)
    published.add_argument("--deployment", required=True)
    published.set_defaults(handler=command_mark_published)

    offline = commands.add_parser("mark-offline", help="record that the live page is offline")
    offline.add_argument("site")
    offline.set_defaults(handler=command_mark_offline)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    root = library_root(args.root)
    try:
        ensure_library(root)
        args.handler(args, root)
        return 0
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
