#!/usr/bin/env python3
"""
Anime Upload <-> ani-cli-arabic bridge.

Speaks JSON-lines over stdin/stdout so the Electron main process can drive the
ani-cli-arabic providers + downloader without touching its interactive TUI.

  python -u bridge.py --tool-dir <path to ani-cli-arabic>

Requests (one JSON object per line on stdin):
  {"id": 1, "cmd": "ping"}
  {"id": 2, "cmd": "providers"}
  {"id": 3, "cmd": "search",   "provider": "anime3rb", "query": "death note"}
  {"id": 4, "cmd": "episodes", "provider": "anime3rb", "anime_id": "death-note"}
  {"id": 5, "cmd": "download", "provider": "anime3rb",
       "anime": {"id": "death-note", "title": "Death Note", "type": "SERIES"},
       "episodes": ["1", "2"], "quality": "1080p", "out_dir": "C:/.../Downloads",
       "parallel": 2, "speed_limit": 0}
  {"id": 6, "cmd": "cancel", "target": 5}

Responses (one JSON object per line on stdout), always carrying the request id:
  {"id": N, "type": "result", "data": ...}
  {"id": N, "type": "error", "error": "message"}
  {"id": N, "type": "progress", "episode": "1", "done": 123, "total": 456, "state": "downloading"}
  {"id": N, "type": "episode_done", "episode": "1", "path": "...", "size": 123}
  {"id": N, "type": "episode_error", "episode": "1", "error": "..."}
  {"id": N, "type": "done", "success": 2, "failed": 0, "folder": "..."}

stdout is reserved for the protocol: anything the tool prints is diverted to stderr.
"""

import argparse
import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# ---- protocol channel -------------------------------------------------------
_PROTO = sys.stdout
sys.stdout = sys.stderr  # tool prints (rich, logger, ...) must never corrupt the protocol
for _s in (_PROTO, sys.stdin, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

_emit_lock = threading.Lock()


def emit(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _emit_lock:
        _PROTO.write(line + "\n")
        _PROTO.flush()


# ---- tool loading -----------------------------------------------------------
BRIDGE_VERSION = 1
_provider_lock = threading.Lock()  # providers scrape one request at a time (same as the CLI)
_jobs = {}  # request id -> threading.Event (cancel flag)
_jobs_lock = threading.Lock()


def load_tool(tool_dir):
    tool_dir = str(Path(tool_dir).resolve())
    if not (Path(tool_dir) / "src" / "providers").is_dir():
        raise RuntimeError(f"not an ani-cli-arabic folder: {tool_dir}")
    sys.path.insert(0, tool_dir)
    os.chdir(tool_dir)
    from src.providers import ProviderManager  # noqa
    from src import downloader as dl  # noqa
    return ProviderManager, dl, tool_dir


def tool_version(tool_dir):
    try:
        txt = (Path(tool_dir) / "src" / "version.py").read_text(encoding="utf-8")
        m = re.search(r"""['"](\d+\.\d+[^'"]*)['"]""", txt)
        return m.group(1) if m else None
    except Exception:
        return None


def to_dict(obj):
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    return obj


# ---- ffmpeg fallback for HLS (.m3u8) ----------------------------------------
def find_ffmpeg():
    p = shutil.which("ffmpeg")
    if p:
        return p
    deps = Path.home() / ".ani-cli-arabic" / "deps"
    if deps.is_dir():
        exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        for f in deps.rglob(exe):
            return str(f)
    return None


def download_hls(url, headers, dest, cancel, on_progress):
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("stream is HLS and ffmpeg was not found")
    part = dest.with_suffix(dest.suffix + ".part")
    hdr = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items() if v)
    cmd = [ff, "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats"]
    if hdr:
        cmd += ["-headers", hdr]
    cmd += ["-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-f", "mp4", str(part)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    err_buf = []
    threading.Thread(target=lambda: err_buf.append(proc.stderr.read()), daemon=True).start()
    for raw in proc.stdout:
        if cancel.is_set():
            proc.kill()
            raise RuntimeError("cancelled")
        line = raw.decode("utf-8", "ignore").strip()
        if line.startswith("total_size="):
            try:
                on_progress(int(line.split("=", 1)[1]), None)
            except ValueError:
                pass
    proc.wait()
    if proc.returncode != 0 or not part.exists():
        msg = (err_buf[0].decode("utf-8", "ignore").strip()[-300:] if err_buf else "") or "ffmpeg failed"
        raise RuntimeError(msg)
    part.replace(dest)


# ---- commands ---------------------------------------------------------------
class Bridge:
    def __init__(self, PM, dl, tool_dir):
        self.PM, self.dl, self.tool_dir = PM, dl, tool_dir

    def provider(self, pid):
        return self.PM.get_provider(pid) if pid else self.PM.get_provider()

    def cmd_ping(self, req):
        return {
            "bridge": BRIDGE_VERSION,
            "tool_version": tool_version(self.tool_dir),
            "python": sys.version.split()[0],
            "ffmpeg": bool(find_ffmpeg()),
        }

    def cmd_providers(self, req):
        return {"providers": self.PM.list_providers(), "active": self.PM.get_active_provider_id()}

    def cmd_search(self, req):
        q = (req.get("query") or "").strip()
        if not q:
            return {"results": []}
        with _provider_lock:
            res = self.provider(req.get("provider")).search_anime(q)
        return {"results": [to_dict(r) for r in (res or [])]}

    def cmd_episodes(self, req):
        with _provider_lock:
            p = self.provider(req.get("provider"))
            eps = p.get_episodes(req["anime_id"])
        return {"episodes": [to_dict(e) for e in (eps or [])]}

    # -- download --
    def cmd_download(self, req):
        rid = req["id"]
        dl = self.dl
        a = req["anime"]
        title = a.get("title") or a.get("id") or "Anime"
        anime = type("A", (), {})()
        anime.id = a["id"]
        anime.type = a.get("type", "SERIES")
        anime.title_en = title
        anime.title_ar = a.get("title_ar", "")
        quality = req.get("quality") or "1080p"
        parallel = max(1, min(int(req.get("parallel") or 2), 4))
        # Total bytes/sec cap (0 = unlimited), split across parallel files.
        speed = int(req.get("speed_limit") or 0)
        per_file_limit = max(1, speed // parallel) if speed > 0 else None

        folder = Path(req["out_dir"]) / dl.sanitize_filename(title).rstrip(". ")
        folder.mkdir(parents=True, exist_ok=True)

        wanted = [str(x) for x in req["episodes"]]
        with _provider_lock:
            p = self.provider(req.get("provider"))
            all_eps = p.get_episodes(anime.id) or []
        by_num = {str(e.number): e for e in all_eps}
        by_disp = {str(e.display_num): e for e in all_eps}
        targets = []
        for n in wanted:
            e = by_num.get(n) or by_disp.get(n)
            if e is None:
                emit({"id": rid, "type": "episode_error", "episode": n, "error": "episode not found"})
            else:
                targets.append((n, e))

        cancel = threading.Event()
        with _jobs_lock:
            _jobs[rid] = cancel
        counts = {"success": 0, "failed": 0}
        lock = threading.Lock()

        def work(n, ep):
            if cancel.is_set():
                return
            dest = folder / dl.episode_filename(anime, ep, quality)
            last = [0.0]

            def prog(done, total, state="downloading", force=False):
                now = time.time()
                if force or now - last[0] >= 0.4:
                    last[0] = now
                    emit({"id": rid, "type": "progress", "episode": n, "done": done,
                          "total": total, "state": state})

            try:
                if dl.is_already_downloaded(dest):
                    emit({"id": rid, "type": "episode_done", "episode": n, "path": str(dest),
                          "size": dest.stat().st_size, "skipped": True})
                    with lock:
                        counts["success"] += 1
                    return
                prog(0, None, "resolving", True)
                with _provider_lock:
                    target = dl.resolve_episode_download_target(p, anime, ep, quality)
                if not target:
                    raise RuntimeError("could not resolve a download link")
                url, headers = target
                if dl.is_hls_url(url):
                    download_hls(url, headers, dest, cancel, lambda d, t: prog(d, t))
                else:
                    sd = dl.StreamDownloader(speed_limit_bytes=per_file_limit)
                    state = {"total": None, "done": 0}

                    class Prog:  # duck-typed stand-in for rich.Progress
                        def update(self, task_id, total=None, completed=None, advance=None, **_):
                            if total is not None:
                                state["total"] = total
                            if completed is not None:
                                state["done"] = completed
                            if advance:
                                state["done"] += advance
                            if cancel.is_set():
                                sd.stop_requested.set()
                            prog(state["done"], state["total"])

                    if not sd.download(url, dest, Prog(), 0, headers=headers):
                        raise RuntimeError("cancelled" if cancel.is_set() else "download failed")
                if cancel.is_set():
                    return
                emit({"id": rid, "type": "episode_done", "episode": n, "path": str(dest),
                      "size": dest.stat().st_size})
                with lock:
                    counts["success"] += 1
            except Exception as e:
                if cancel.is_set():
                    return
                emit({"id": rid, "type": "episode_error", "episode": n, "error": str(e) or e.__class__.__name__})
                with lock:
                    counts["failed"] += 1

        try:
            with ThreadPoolExecutor(max_workers=parallel) as ex:
                for n, ep in targets:
                    ex.submit(work, n, ep)
        finally:
            with _jobs_lock:
                _jobs.pop(rid, None)
        return {"_final": {"type": "done", "success": counts["success"], "failed": counts["failed"],
                           "cancelled": cancel.is_set(), "folder": str(folder)}}

    def cmd_cancel(self, req):
        with _jobs_lock:
            ev = _jobs.get(req.get("target"))
        if ev:
            ev.set()
        return {"cancelled": bool(ev)}

    def handle(self, req):
        rid = req.get("id")
        try:
            fn = getattr(self, "cmd_" + str(req.get("cmd")), None)
            if not fn:
                raise RuntimeError(f"unknown command: {req.get('cmd')}")
            out = fn(req)
            if isinstance(out, dict) and "_final" in out:
                emit({"id": rid, **out["_final"]})
            else:
                emit({"id": rid, "type": "result", "data": out})
        except Exception as e:
            emit({"id": rid, "type": "error", "error": str(e) or e.__class__.__name__})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool-dir", required=True)
    args = ap.parse_args()
    try:
        PM, dl, tool_dir = load_tool(args.tool_dir)
    except Exception as e:  # missing deps (ModuleNotFoundError) land here too
        emit({"id": 0, "type": "fatal", "error": f"{e.__class__.__name__}: {e}"})
        return 2
    bridge = Bridge(PM, dl, tool_dir)
    emit({"id": 0, "type": "ready", "bridge": BRIDGE_VERSION, "tool_version": tool_version(tool_dir)})
    pool = ThreadPoolExecutor(max_workers=16)
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        pool.submit(bridge.handle, req)
    return 0


if __name__ == "__main__":
    sys.exit(main())
