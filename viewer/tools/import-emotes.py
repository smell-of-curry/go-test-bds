#!/usr/bin/env python3
"""Import readable persona emotes from an installed Bedrock client, without decryption.

Generated assets are local-only. Nothing is extracted into the Minecraft install.
brarchive layout: github.com/LPaicen/brarchive-extractor/docs/brarchive-format.md
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct
import uuid
import zipfile

MAGIC = bytes.fromhex("7d2725b1a0527026")
LIMIT = 32 * 1024 * 1024


def safe_name(name):
    path = PurePosixPath(name)
    if not name or "\x00" in name or "\\" in name or ":" in name or path.is_absolute() or ".." in path.parts:
        raise ValueError("unsafe archive entry name")
    return str(path)


def read_brarchive(data):
    if len(data) < 16 or data[:8] != MAGIC:
        raise ValueError("invalid brarchive header")
    count, version = struct.unpack_from("<II", data, 8)
    base = 16 + count * 256
    if version != 1 or base > len(data):
        raise ValueError("unsupported version or truncated index")
    result, seen = {}, set()
    for i in range(count):
        entry = 16 + i * 256
        length = data[entry]
        if not 0 < length <= 247:
            raise ValueError("invalid name length")
        name = safe_name(data[entry + 1:entry + 1 + length].decode("utf-8"))
        offset, size = struct.unpack_from("<II", data, entry + 248)
        if size > LIMIT or base + offset + size > len(data) or name.casefold() in seen:
            raise ValueError("invalid payload range or duplicate entry")
        seen.add(name.casefold())
        result[name] = data[base + offset:base + offset + size]
    return result


def read_zip(path):
    result, seen = {}, set()
    with zipfile.ZipFile(path) as archive:
        total = 0
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = safe_name(entry.filename)
            total += entry.file_size
            if total > LIMIT or name.casefold() in seen:
                raise ValueError("oversized or duplicate ZIP entry")
            seen.add(name.casefold())
            result[name] = archive.read(entry)
    return result


def decode_json(raw):
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def collect_package(entries, source, digest):
    """Resolve UUID -> animation through native metadata, never guessed file names."""
    metas = {k: decode_json(v) for k, v in entries.items() if k.endswith(".meta.json")}
    candidates = [k for k in entries if "animation" in k or k.endswith(".meta.json")]
    row = {"source": source, "sha256": digest, "entries": sorted(candidates), "status": "not_an_emote"}
    result = []
    for name, meta in metas.items():
        if not isinstance(meta, dict) or meta.get("piece_type") != "persona_emote":
            continue
        row["status"] = "missing_animation"
        identifier = str(uuid.UUID(meta["piece_id"]))
        sources = meta.get("animation_sources", [])
        # Multiple sources need explicit selection semantics; do not silently play one.
        if len(sources) != 1:
            row["status"] = "unsupported_animation_sources"
            continue
        binding = sources[0]
        animation_file = safe_name(str(PurePosixPath(name).parent / binding["animationFile"]))
        raw = entries.get(animation_file)
        doc = decode_json(raw) if raw is not None else None
        animation_name = binding["name"]
        if not isinstance(doc, dict) or animation_name not in doc.get("animations", {}):
            continue
        result.append({"id": identifier, "name": meta["piece_name"],
                       "animationName": animation_name, "document": doc,
                       "source": source, "sourceSha256": digest,
                       "animationSha256": hashlib.sha256(raw).hexdigest()})
        row["status"] = "imported"
        row["id"] = identifier
        row["name"] = meta["piece_name"]
    if candidates and row["status"] == "not_an_emote":
        row["status"] = "unreadable_metadata" if any(v is None for v in metas.values()) else "unresolved_animation"
    return result, row


def discover_assets():
    versions = Path.home() / "Library/Application Support/mcpelauncher/versions"
    found = [p for p in versions.glob("*/assets/assets/resource_packs/persona") if p.is_dir()]
    if not found:
        raise ValueError("No installed persona pack found; pass --persona explicitly")
    return max(found, key=lambda p: tuple(int(n) for n in p.parents[3].name.split(".")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--persona", type=Path, help="Installed resource_packs/persona directory")
    parser.add_argument("--persona-cache", type=Path, default=Path.home() / "Library/Application Support/mcpelauncher/premium_cache/persona")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".cache/emotes")
    parser.add_argument("--catalog", type=Path, help="Optional Bedrock-Persona persona_emote/items.json snapshot (metadata only)")
    args = parser.parse_args()
    persona = args.persona or discover_assets()
    if not persona.is_dir():
        parser.error(f"Not a persona directory: {persona}")
    packages = []
    for path in sorted(persona.rglob("*.brarchive")):
        packages.append((path, lambda p=path: read_brarchive(p.read_bytes())))
    for path in sorted(persona.rglob("*.meta.json")):
        # Older installs ship loose files instead of brarchives.
        packages.append((path, lambda p=path: {f.name: f.read_bytes() for f in p.parent.glob("*.json") if f.stat().st_size <= LIMIT}))
    if args.persona_cache.is_dir():
        for path in sorted(args.persona_cache.iterdir()):
            if path.is_file() and zipfile.is_zipfile(path):
                packages.append((path, lambda p=path: read_zip(p)))
    emotes, inventory = {}, []
    for path, read in packages:
        try:
            if path.stat().st_size > LIMIT:
                raise ValueError("oversized package")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            found, row = collect_package(read(), str(path), digest)
            for emote in found:
                old = emotes.get(emote["id"])
                if old and old["animationSha256"] != emote["animationSha256"]:
                    raise ValueError(f"conflicting native animation for {emote['id']}")
                emotes[emote["id"]] = emote
            inventory.append(row)
        except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, RuntimeError) as exc:
            # Archive corruption is not evidence that assets are absent.
            raise ValueError(f"Cannot import {path}: {exc}") from exc
    if not emotes:
        parser.error("No readable emotes found; previous dataset left untouched")
    args.output.mkdir(parents=True, exist_ok=True)
    runtime = {"schemaVersion": 1, "emotes": sorted(emotes.values(), key=lambda e: e["id"])}
    catalog = {"schemaVersion": 1, "persona": str(persona), "packages": inventory,
               "summary": {"playable": len(emotes), "unreadable": sum(r["status"] == "unreadable_metadata" for r in inventory), "packages": len(inventory)}}
    if args.catalog:
        rows = json.loads(args.catalog.read_text())
        if not isinstance(rows, list) or any(r.get("pieceType") != "persona_emote" for r in rows):
            parser.error("Expected a persona_emote catalog items array")
        catalog["onlineSource"] = {
            "url": "https://github.com/Daniel-Ric/Bedrock-Persona/tree/main/data/persona_emote",
            "sha256": hashlib.sha256(args.catalog.read_bytes()).hexdigest(),
            "note": "Community catalog snapshot, not proof of complete coverage or animation availability. Catalog ID and piece UUID are distinct.",
        }
        catalog["onlineEmotes"] = [
            {"catalogId": r["id"], "pieceUuid": r["uuid"], "name": r["title"],
             "creator": r.get("creatorName"),
             "status": "imported" if r["uuid"] in emotes else "metadata_only"}
            for r in rows
        ]
        catalog["summary"]["onlineCatalogEntries"] = len(rows)
    for name, value in [("runtime.json", runtime), ("catalog.json", catalog)]:
        target = args.output / name
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(target)
    print(json.dumps(catalog["summary"]))
    print(f"Dataset: {args.output}")


if __name__ == "__main__":
    main()
