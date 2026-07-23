#!/usr/bin/env python3
"""Lightweight structural and publication-safety audit for the Foxwarm code index."""

from __future__ import annotations

import argparse
import collections
import difflib
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
DATE_RE = re.compile(r"\[20\d\d-\d\d-\d\d\]")
PRIVATE_PATTERNS = [
    ("personal Linux home path", re.compile(r"(?<![\w-])/home/[A-Za-z0-9._-]+/")),
    ("personal macOS home path", re.compile(r"(?<![\w-])/Users/[A-Za-z0-9._-]+/")),
    ("personal Windows home path", re.compile(r"[A-Za-z]:\\\\Users\\\\[^\\\s]+\\", re.I)),
    ("private key material", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    (
        "credential-like assignment",
        re.compile(
            r"\b(?:api[_ -]?key|access[_ -]?token|secret|password)\b\s*[:=]\s*"
            r"(?:[`\"']?)(?!<|\$|\{|redacted\b|example\b|placeholder\b|none\b)"
            r"[A-Za-z0-9_./+=-]{12,}",
            re.I,
        ),
    ),
]


@dataclass(frozen=True)
class Finding:
    level: str
    code: str
    path: str
    line: int
    message: str


def github_anchors(text: str) -> set[str]:
    counts: collections.Counter[str] = collections.Counter()
    anchors: set[str] = set()
    for line in text.splitlines():
        match = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", line)
        if not match:
            continue
        heading = re.sub(r"<[^>]+>", "", match.group(1))
        heading = re.sub(r"[`*_~]", "", heading).strip().lower()
        heading = re.sub(r"[^\w\- ]", "", heading, flags=re.UNICODE)
        slug = re.sub(r"\s+", "-", heading)
        count = counts[slug]
        counts[slug] += 1
        anchors.add(slug if count == 0 else f"{slug}-{count}")
    return anchors


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def normalize_owned_path(raw: str) -> str:
    value = raw.strip().strip("`")
    value = re.sub(r"\s+\([^)]*\)\s*$", "", value)
    return value.rstrip("/")


def parse_file_declarations(doc: Path) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    primary: list[tuple[int, str]] = []
    secondary: list[tuple[int, str]] = []
    for number, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), 1):
        destination = primary if line.startswith("Files:") else secondary if line.startswith("Secondary files:") else None
        if destination is None:
            continue
        raw_values = line.split(":", 1)[1]
        for raw in raw_values.split(","):
            value = normalize_owned_path(raw)
            if value:
                destination.append((number, value))
    return primary, secondary


def extract_decisions(path: Path, text: str) -> list[tuple[int, str]]:
    lines = text.splitlines()
    in_section = False
    decisions: list[tuple[int, str]] = []
    block_line = 0
    block: list[str] = []

    def flush() -> None:
        nonlocal block_line, block
        value = " ".join(part.strip() for part in block if part.strip())
        if value:
            decisions.append((block_line, value))
        block_line = 0
        block = []

    for number, line in enumerate(lines, 1):
        if line == "## Design Decisions":
            flush()
            in_section = True
            continue
        if in_section and line.startswith("## "):
            flush()
            in_section = False
        if not in_section:
            continue
        if line.startswith("### "):
            flush()
            block_line = number
            block = [line[4:]]
        elif line.startswith("- "):
            flush()
            block_line = number
            block = [line[2:]]
        elif block_line and line.strip():
            block.append(line)
    flush()
    return decisions


def normalized_decision(text: str) -> str:
    text = DATE_RE.sub("", text.lower())
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[[^\]]+\]\([^)]+\)", " ", text)
    text = re.sub(r"[^a-z0-9_\s-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def audit(index_root: Path, source_root: Path, fail_on_cjk: bool) -> list[Finding]:
    findings: list[Finding] = []
    markdown = sorted(index_root.rglob("*.md"))
    texts = {path: path.read_text(encoding="utf-8") for path in markdown}
    anchors = {path: github_anchors(text) for path, text in texts.items()}
    incoming: collections.Counter[Path] = collections.Counter()

    for path, text in texts.items():
        rel = path.relative_to(index_root).as_posix()
        for match in LINK_RE.finditer(text):
            raw = match.group(1).strip()
            if not raw or raw.startswith(("http://", "https://", "mailto:")):
                continue
            target_text, _, fragment = raw.partition("#")
            target = path if not target_text else (path.parent / unquote(target_text)).resolve()
            number = line_number(text, match.start())
            try:
                target.relative_to(index_root.resolve())
            except ValueError:
                findings.append(Finding("ERROR", "link-escape", rel, number, f"link escapes index root: {raw}"))
                continue
            if not target.exists():
                findings.append(Finding("ERROR", "broken-link", rel, number, f"missing target: {raw}"))
                continue
            if target.is_file() and target.suffix == ".md":
                incoming[target] += 1
                if fragment and fragment not in anchors.get(target, set()):
                    findings.append(Finding("ERROR", "broken-anchor", rel, number, f"missing anchor: {raw}"))

        matches = list(CJK_RE.finditer(text))
        if matches:
            level = "ERROR" if fail_on_cjk else "WARN"
            first = matches[0]
            findings.append(
                Finding(level, "cjk", rel, line_number(text, first.start()), f"{len(matches)} CJK character(s); translate before publication")
            )

        for label, pattern in PRIVATE_PATTERNS:
            for match in pattern.finditer(text):
                findings.append(Finding("ERROR", "privacy", rel, line_number(text, match.start()), label))

    overview = (index_root / "overview.md").resolve()
    for path in sorted((index_root / "modules").glob("*.md")) + sorted((index_root / "threads").glob("*.md")):
        if incoming[path.resolve()] == 0:
            findings.append(Finding("ERROR", "orphan-navigation", path.relative_to(index_root).as_posix(), 1, "module/thread is not linked from overview or another index document"))
    for path in sorted((index_root / "units").glob("*.md")):
        if incoming[path.resolve()] == 0:
            findings.append(Finding("WARN", "orphan-unit", path.relative_to(index_root).as_posix(), 1, "unit is not linked from a module or thread"))

    owners: collections.defaultdict[str, list[tuple[str, int]]] = collections.defaultdict(list)
    for doc in sorted((index_root / "units").glob("*.md")):
        rel = doc.relative_to(index_root).as_posix()
        primary, secondary = parse_file_declarations(doc)
        if not primary:
            findings.append(Finding("ERROR", "missing-files", rel, 1, "unit has no primary Files declaration"))
        for number, value in primary:
            owners[value].append((rel, number))
        for kind, values in (("primary", primary), ("secondary", secondary)):
            for number, value in values:
                target = (source_root / value).resolve()
                try:
                    target.relative_to(source_root.resolve())
                except ValueError:
                    findings.append(Finding("ERROR", "source-escape", rel, number, f"{kind} path escapes source root: {value}"))
                    continue
                if not target.exists():
                    findings.append(Finding("ERROR", "missing-source", rel, number, f"{kind} source path does not exist: {value}"))
    for value, claims in sorted(owners.items()):
        if len(claims) > 1:
            claim_text = ", ".join(f"{path}:{line}" for path, line in claims)
            findings.append(Finding("ERROR", "duplicate-primary", claims[0][0], claims[0][1], f"{value} claimed by {claim_text}"))

    all_decisions: list[tuple[Path, int, str, str]] = []
    for path, text in texts.items():
        decisions = extract_decisions(path, text)
        rel = path.relative_to(index_root).as_posix()
        if len(decisions) >= 15 or (len(decisions) >= 8 and len(decisions) / max(1, len(text.splitlines())) > 0.18):
            findings.append(Finding("WARN", "decision-density", rel, decisions[0][0], f"{len(decisions)} decision entries; curate or split this document"))
        for number, decision in decisions:
            normalized = normalized_decision(decision)
            if len(normalized) >= 50:
                all_decisions.append((path, number, decision, normalized))

    for i, left in enumerate(all_decisions):
        left_words = set(left[3].split())
        for right in all_decisions[i + 1 :]:
            if left[0] == right[0]:
                continue
            right_words = set(right[3].split())
            union = left_words | right_words
            if not union or len(left_words & right_words) / len(union) < 0.55:
                continue
            ratio = difflib.SequenceMatcher(None, left[3], right[3]).ratio()
            if ratio < 0.88:
                continue
            left_rel = left[0].relative_to(index_root).as_posix()
            right_rel = right[0].relative_to(index_root).as_posix()
            findings.append(Finding("WARN", "similar-decision", left_rel, left[1], f"similar to {right_rel}:{right[1]} ({ratio:.0%}); reconcile canonical owner"))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--fail-on-cjk", action="store_true", help="treat non-English CJK baseline findings as errors")
    parser.add_argument("--max-details", type=int, default=120)
    args = parser.parse_args()

    index_root = args.index_root.resolve()
    source_root = args.source_root.resolve()
    if not (index_root / "overview.md").is_file():
        parser.error(f"not a code-index root: {index_root}")
    if not source_root.is_dir():
        parser.error(f"source root does not exist: {source_root}")

    findings = audit(index_root, source_root, args.fail_on_cjk)
    errors = [item for item in findings if item.level == "ERROR"]
    warnings = [item for item in findings if item.level == "WARN"]
    for item in findings[: args.max_details]:
        print(f"{item.level} {item.code} {item.path}:{item.line}: {item.message}")
    if len(findings) > args.max_details:
        print(f"... {len(findings) - args.max_details} additional finding(s) omitted; increase --max-details")
    counts = collections.Counter(item.code for item in findings)
    summary = ", ".join(f"{key}={value}" for key, value in sorted(counts.items())) or "none"
    print(f"Summary: errors={len(errors)}, warnings={len(warnings)}, findings={summary}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
