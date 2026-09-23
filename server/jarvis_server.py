"""
jarvis_server.py — HTTP + WebSocket server for MARK LIII
=========================================================
Gives Jarvis a REST/WebSocket API so it can:
  • Receive chat commands from a phone, script, or any HTTP client
  • Report its status and memory
  • Accept commands for any registered action

Endpoints
---------
  GET  /status          — health check + state
  POST /chat            — send a text message; Jarvis replies via its normal pipeline
  WS   /ws              — live bidirectional chat stream
  GET  /memory          — read all stored memory entries
  POST /action          — trigger a registered action by name
  GET  /log             — last N log lines

Security
--------
A random token is generated on first launch and stored in config/api_keys.json
under "server_token". All requests must include header:
  Authorization: Bearer <token>
… or pass token as query param: ?token=<token>

The server binds to 0.0.0.0:8765 (LAN-accessible) by default.
Set "server_host": "127.0.0.1" in config/api_keys.json for localhost-only.

Install deps:
  pip install fastapi "uvicorn[standard]"
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path
from typing import Any

# ── FastAPI imports (optional — server disabled if not installed) ──────────────
try:
    from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Query, Header
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    _FASTAPI_OK = True
except ImportError:
    _FASTAPI_OK = False


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


_BASE       = _base_dir()
_CONFIG     = _BASE / "config" / "api_keys.json"
_SERVER_PORT = 8765


# ── Config helpers ─────────────────────────────────────────────────────────────
def _load_config() -> dict:
    try:
        return json.loads(_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_config(d: dict) -> None:
    try:
        _CONFIG.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _get_or_create_token() -> str:
    """Return the server auth token, creating one if absent."""
    cfg = _load_config()
    tok = cfg.get("server_token", "")
    if not tok:
        tok = secrets.token_urlsafe(32)
        cfg["server_token"] = tok
        _save_config(cfg)
    return tok


def _get_host() -> str:
    return _load_config().get("server_host", "0.0.0.0")


# ── Global state shared with main.py ─────────────────────────────────────────
# main.py sets these when it starts the server.
_jarvis_state: dict[str, Any] = {
    "state":          "INITIALISING",   # LISTENING | SPEAKING | THINKING | SLEEPING
    "send_message":   None,             # callable(text: str) — sends to Gemini Live
    "action_registry": None,            # from core.action_loader
    "plugin_registry": None,            # from core.plugin_loader
    "log_lines":      [],               # last 200 log lines
    "muted":          False,
}

_ws_clients: set[WebSocket] = set()


def set_state(state: str) -> None:
    _jarvis_state["state"] = state


def set_send_fn(fn) -> None:
    _jarvis_state["send_message"] = fn


def set_registries(action_reg, plugin_reg) -> None:
    _jarvis_state["action_registry"] = action_reg
    _jarvis_state["plugin_registry"] = plugin_reg


def append_log(line: str) -> None:
    """Called from JarvisLive to mirror log into the server's log buffer."""
    lines = _jarvis_state["log_lines"]
    lines.append({"ts": time.strftime("%H:%M:%S"), "text": line})
    if len(lines) > 200:
        lines.pop(0)
    # Broadcast to all connected WebSocket clients
    asyncio.get_event_loop().call_soon_threadsafe(
        lambda: asyncio.ensure_future(_broadcast({"type": "log", "text": line}))
    ) if _ws_loop else None


_ws_loop: asyncio.AbstractEventLoop | None = None


async def _broadcast(msg: dict) -> None:
    dead = set()
    for ws in list(_ws_clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)


# ── FastAPI app ────────────────────────────────────────────────────────────────
if _FASTAPI_OK:
    app = FastAPI(title="JARVIS Server", version="LIII")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Auth dependency ────────────────────────────────────────────────────────
    def _auth(
        authorization: str | None = Header(default=None),
        token: str | None = Query(default=None),
    ) -> None:
        """Check Bearer token or ?token= query param."""
        _tok = _get_or_create_token()
        bearer = ""
        if authorization and authorization.lower().startswith("bearer "):
            bearer = authorization[7:].strip()
        provided = bearer or token or ""
        if provided != _tok:
            raise HTTPException(status_code=401, detail="Unauthorized — bad token.")

    # ── Routes ────────────────────────────────────────────────────────────────
    @app.get("/status")
    async def status(_=Depends(_auth)):
        """Health check."""
        cfg = _load_config()
        return {
            "ok":      True,
            "state":   _jarvis_state["state"],
            "muted":   _jarvis_state["muted"],
            "version": "MARK LIII",
            "name":    cfg.get("assistant_name", "JARVIS"),
            "user":    cfg.get("user_name", ""),
        }

    @app.post("/chat")
    async def chat(body: dict, _=Depends(_auth)):
        """
        Send a text message to JARVIS.
        Body: {"text": "your message here"}
        """
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="'text' field is required.")
        send_fn = _jarvis_state.get("send_message")
        if not send_fn:
            return JSONResponse({"ok": False, "error": "Session not ready yet."}, 503)
        # Run in a thread since send_fn may be sync or async-scheduled
        threading.Thread(target=send_fn, args=(text,), daemon=True).start()
        return {"ok": True, "sent": text}

    @app.get("/memory")
    async def memory(_=Depends(_auth)):
        """Return all stored long-term memory entries."""
        try:
            from memory.memory_manager import load_memory
            return {"ok": True, "memory": load_memory()}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/action")
    async def action(body: dict, _=Depends(_auth)):
        """
        Trigger a registered action by name.
        Body: {"name": "action_name", "args": {...}}
        """
        name = (body.get("name") or "").strip()
        args = body.get("args") or {}
        if not name:
            raise HTTPException(status_code=400, detail="'name' is required.")
        reg = _jarvis_state.get("action_registry")
        if reg and reg.has(name):
            try:
                result = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: reg.run(name, args, {})
                )
                return {"ok": True, "result": result}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
        plug = _jarvis_state.get("plugin_registry")
        if plug and plug.has(name):
            try:
                result = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: plug.run(name, args, player=None, session_memory=None)
                )
                return {"ok": True, "result": result}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=404, detail=f"Action '{name}' not found.")

    @app.get("/log")
    async def log(n: int = 50, _=Depends(_auth)):
        """Return the last N log lines."""
        lines = _jarvis_state["log_lines"]
        return {"ok": True, "lines": lines[-n:]}

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket, token: str = Query(default="")):
        """
        Live bidirectional WebSocket chat.
        Connect with: ws://HOST:8765/ws?token=<token>
        Send: {"text": "your message"}
        Receive: {"type": "log"/"reply", "text": "..."}
        """
        _tok = _get_or_create_token()
        if token != _tok:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        _ws_clients.add(websocket)
        try:
            while True:
                data = await websocket.receive_json()
                text = (data.get("text") or "").strip()
                if text:
                    send_fn = _jarvis_state.get("send_message")
                    if send_fn:
                        threading.Thread(target=send_fn, args=(text,), daemon=True).start()
                    await websocket.send_json({"type": "ack", "text": text})
        except WebSocketDisconnect:
            _ws_clients.discard(websocket)
        except Exception:
            _ws_clients.discard(websocket)


# ── Server startup ─────────────────────────────────────────────────────────────
_server_thread: threading.Thread | None = None
_server_running = False


def start_server(
    send_fn=None,
    action_reg=None,
    plugin_reg=None,
    log_fn=None,
) -> tuple[bool, str]:
    """
    Start the FastAPI server in a background thread.
    Returns (ok, message).

    Called from main.py's JarvisLive.run() when server mode is enabled.
    """
    global _server_thread, _server_running, _ws_loop

    if not _FASTAPI_OK:
        return False, 'FastAPI/uvicorn not installed. Run: pip install fastapi "uvicorn[standard]"'

    if _server_running:
        return True, "Server already running."

    # Wire in the live session bridge functions
    if send_fn:
        set_send_fn(send_fn)
    if action_reg or plugin_reg:
        set_registries(action_reg, plugin_reg)

    token = _get_or_create_token()
    host  = _get_host()
    port  = _SERVER_PORT

    def _run():
        global _server_running, _ws_loop
        _server_running = True
        _ws_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_ws_loop)
        config = uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="warning",
            loop="asyncio",
        )
        server = uvicorn.Server(config)
        _ws_loop.run_until_complete(server.serve())
        _server_running = False

    _server_thread = threading.Thread(target=_run, daemon=True, name="JarvisServer")
    _server_thread.start()

    time.sleep(0.8)  # let uvicorn bind

    local_ip = _get_local_ip()
    url = f"http://{local_ip}:{port}"
    msg = (
        f"JARVIS Server running on {url}\n"
        f"Token: {token}\n"
        f"Chat: POST {url}/chat  {{\"text\":\"...\"}}\n"
        f"WebSocket: ws://{local_ip}:{port}/ws?token={token}"
    )
    if log_fn:
        log_fn(f"SYS: Server online — {url} (token saved in config)")
    print(f"[Server] {msg}")
    return True, msg


def _get_local_ip() -> str:
    """Return best-guess LAN IP."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def get_server_info() -> dict:
    """Return server connection info for the UI (QR code, URL, token)."""
    if not _server_running:
        return {"running": False}
    local_ip = _get_local_ip()
    token    = _get_or_create_token()
    port     = _SERVER_PORT
    return {
        "running": True,
        "url":     f"http://{local_ip}:{port}",
        "token":   token,
        "ws_url":  f"ws://{local_ip}:{port}/ws?token={token}",
        "chat_url": f"http://{local_ip}:{port}/chat",
    }
