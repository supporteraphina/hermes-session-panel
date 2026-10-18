#!/usr/bin/env python3
"""Backend half of the Hermes Session panel desktop plugin.

Reads one chat (and the chats it was compressed from) out of state.db read only and
prints compact JSON: where the chat works (folder, git repo, branch), the files it
delivered, and the pull requests it opened, with their live state from GitHub.

    panel.py --session <stored id> [--cwd <dir>]      JSON, or {"chunks": n, "key": k} when long
    panel.py --chunk <i> --key <k>                    one slice of a long answer

Stdlib only. shell.exec keeps only the last 4000 characters of stdout, so long answers
are written to a file and read back in slices.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
STATE = HOME / "session-panel"
PR_CACHE = STATE / "pr-cache.json"
CHUNK = 3500
MAX_OUTPUTS = 30
MAX_PRS = 12

PR_RE = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
MEDIA_RE = re.compile(r"MEDIA:(/[^\s)\]`'\"<>]+)")
SKIP_PARTS = ("/.hermes/cache/", "/tmp/", "/.worktrees/", "/node_modules/")
GH_ENV = {**os.environ, "GH_CONFIG_DIR": str(Path.home() / ".config" / "gh"), "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"}
for var in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "DISPLAY"):
    GH_ENV.pop(var, None)


def run(args: list[str], cwd: str | None = None, timeout: float = 8) -> str:
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=GH_ENV)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def lineage(db: sqlite3.Connection, session_id: str) -> list[str]:
    """The chat plus every chat it was compressed from, oldest first."""
    ids, seen, cur = [], set(), session_id
    while cur and cur not in seen and len(ids) < 50:
        seen.add(cur)
        ids.append(cur)
        row = db.execute("select parent_session_id from sessions where id = ?", (cur,)).fetchone()
        cur = row[0] if row else None
    return list(reversed(ids))


def git_info(cwd: str) -> dict | None:
    if not cwd or not os.path.isdir(cwd):
        return None
    root = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
    if not root:
        return None
    info = {"root": root, "branch": run(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"])}
    remote = run(["git", "-C", root, "remote", "get-url", "origin"])
    m = re.search(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?$", remote)
    info["repo"] = f"{m.group(1)}/{m.group(2)}" if m else (Path(root).name if not remote else remote.rsplit("/", 1)[-1])
    status = run(["git", "-C", root, "status", "--porcelain"])
    info["dirty"] = len([line for line in status.splitlines() if line.strip()])
    stat = run(["git", "-C", root, "diff", "--shortstat", "HEAD"])
    add = re.search(r"(\d+) insertion", stat)
    dele = re.search(r"(\d+) deletion", stat)
    info["add"] = int(add.group(1)) if add else 0
    info["del"] = int(dele.group(1)) if dele else 0
    return info


def scan(db: sqlite3.Connection, ids: list[str]) -> tuple[list[dict], list[str]]:
    outputs: dict[str, dict] = {}
    prs: dict[str, float] = {}
    marks = ",".join("?" * len(ids))
    rows = db.execute(
        f"select role, content, tool_calls, timestamp from messages where session_id in ({marks}) order by timestamp, id",
        ids,
    )
    for role, content, tool_calls, ts in rows:
        ts = float(ts or 0)
        text = content if isinstance(content, str) else ""
        if role == "assistant" and tool_calls:
            try:
                calls = json.loads(tool_calls)
            except Exception:
                calls = []
            for call in calls or []:
                fn = (call or {}).get("function") or {}
                if fn.get("name") != "write_file":
                    continue
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                path = args.get("path")
                if isinstance(path, str) and path.startswith("/"):
                    outputs[path] = {"path": path, "ts": ts, "via": "write"}
        if role == "assistant" and "MEDIA:" in text:
            for path in MEDIA_RE.findall(text):
                outputs[path.rstrip(".,;")] = {"path": path.rstrip(".,;"), "ts": ts, "via": "media"}
        if role in ("tool", "assistant") and "github.com/" in text:
            for owner, repo, num in PR_RE.findall(text):
                prs[f"https://github.com/{owner}/{repo}/pull/{num}"] = ts
    files = []
    for item in sorted(outputs.values(), key=lambda o: -o["ts"]):
        path = item["path"]
        if item["via"] == "write" and any(part in path for part in SKIP_PARTS):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        files.append({"path": path, "size": st.st_size, "ts": int(item["ts"])})
        if len(files) >= MAX_OUTPUTS:
            break
    ordered = [url for url, _ in sorted(prs.items(), key=lambda kv: -kv[1])][:MAX_PRS]
    return files, ordered


def pr_details(urls: list[str]) -> list[dict]:
    try:
        cache = json.loads(PR_CACHE.read_text())
    except Exception:
        cache = {}
    now = time.time()

    def fresh(url: str) -> bool:
        hit = cache.get(url)
        if not hit:
            return False
        ttl = 7 * 86400 if hit.get("state") in ("MERGED", "CLOSED") else 120
        return now - hit.get("at", 0) < ttl

    def fetch(url: str) -> tuple[str, dict | None]:
        raw = run(["gh", "pr", "view", url, "--json", "number,title,state,additions,deletions,isDraft,headRefName"], timeout=12)
        try:
            data = json.loads(raw)
        except Exception:
            return url, None
        data["at"] = now
        return url, data

    todo = [u for u in urls if not fresh(u)]
    if todo:
        with cf.ThreadPoolExecutor(max_workers=6) as pool:
            for url, data in pool.map(fetch, todo):
                if data:
                    cache[url] = data
        try:
            STATE.mkdir(parents=True, exist_ok=True)
            PR_CACHE.write_text(json.dumps(cache))
        except OSError:
            pass
    out = []
    for url in urls:
        m = PR_RE.search(url)
        hit = cache.get(url) or {}
        out.append({
            "url": url,
            "repo": m.group(2),
            "num": int(m.group(3)),
            "title": (hit.get("title") or "")[:90],
            "state": hit.get("state") or "",
            "draft": bool(hit.get("isDraft")),
            "add": hit.get("additions"),
            "del": hit.get("deletions"),
        })
    return out


def build(session_id: str, cwd: str) -> dict:
    db_path = HOME / "state.db"
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        ids = lineage(db, session_id) if session_id else []
        row = db.execute("select cwd, git_branch from sessions where id = ?", (session_id,)).fetchone() if session_id else None
        session_cwd = (row[0] if row else None) or cwd or str(Path.home())
        files, pr_urls = scan(db, ids) if ids else ([], [])
    finally:
        db.close()
    return {
        "host": socket.gethostname(),
        "user": os.environ.get("USER") or Path.home().name,
        "cwd": session_cwd,
        "git": git_info(session_cwd),
        "outputs": files,
        "prs": pr_details(pr_urls) if pr_urls else [],
        "chats": len(ids),
        "at": int(time.time()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--chunk", type=int)
    ap.add_argument("--key", default="")
    a = ap.parse_args()
    if a.chunk is not None:
        key = re.sub(r"[^\w.-]", "_", a.key)[:80]
        text = (STATE / f"out-{key}.json").read_text()
        print(text[a.chunk * CHUNK:(a.chunk + 1) * CHUNK], end="")
        return
    text = json.dumps(build(a.session, a.cwd), separators=(",", ":"))
    if len(text) <= CHUNK:
        print(text)
        return
    key = re.sub(r"[^\w.-]", "_", a.session or "none")[:80]
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / f"out-{key}.json").write_text(text)
    print(json.dumps({"chunks": (len(text) + CHUNK - 1) // CHUNK, "key": key}))


if __name__ == "__main__":
    main()
