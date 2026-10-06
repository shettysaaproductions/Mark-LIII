"""
laya_win.py — Local Laya Decision Engine for MARK LIII (Windows)
================================================================
Runs the Laya typed-decision model locally using ONNX Runtime.
No cloud API, no network after first download, no GPU required.
Estimated latency: 20–60ms per decision on modern Windows CPU.

What Laya does
--------------
It answers CONSTRAINED questions (not generative text):
  • choice  — "Which direction?" → UP / DOWN / LEFT / RIGHT
  • noul    — "Is this game over?" → True (0.94 confidence)
  • score   — "How urgent is this?" → 0.78 / 1.0

It uses a bidirectional ModernBERT encoder (421M params) + decision heads.
No token-by-token decoding = extremely fast.

First run downloads ~800 MB of model weights from HuggingFace once.
All subsequent calls are fully offline.

TOOL dict — auto-discovered by core.action_loader.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

# ── TOOL declaration (for Jarvis to call via voice/chat) ─────────────────────
TOOL = {
    "name": "laya_decide",
    "description": (
        "Make an ultra-fast LOCAL decision using the Laya model (no internet needed). "
        "Use for: routing tasks to the right tool, checking if a game is over, "
        "classifying urgency, or any multiple-choice or yes/no question. "
        "Runs in 20–60ms on CPU. Free and unlimited."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "state": {
                "type": "STRING",
                "description": "The context or situation to decide about.",
            },
            "question": {
                "type": "STRING",
                "description": "The question to answer.",
            },
            "question_type": {
                "type": "STRING",
                "description": "One of: 'choice' (pick from options), 'noul' (yes/no), 'score' (0–1 rating).",
            },
            "options": {
                "type": "ARRAY",
                "description": "For 'choice' type: the list of options to choose from. e.g. ['UP','DOWN','LEFT','RIGHT']",
                "items": {"type": "STRING"},
            },
        },
        "required": ["state", "question", "question_type"],
    },
}


# ── Paths ──────────────────────────────────────────────────────────────────────
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


_MODELS_DIR  = _base_dir() / "models" / "laya"
_MODEL_ID    = "convaiinnovations/laya"          # HuggingFace model ID
_ONNX_PATH   = _MODELS_DIR / "model.onnx"
_TOKENIZER   = _MODELS_DIR / "tokenizer"
_READY_FILE  = _MODELS_DIR / ".ready"           # exists after successful export


# ── Model state ───────────────────────────────────────────────────────────────
_model_lock   = threading.Lock()
_session      = None    # onnxruntime.InferenceSession  (preferred)
_hf_model     = None    # transformers model            (fallback)
_tokenizer_   = None    # transformers tokenizer
_loading      = False
_load_failed  = False   # set True if we've already tried and failed
_backend      = None    # "onnx" | "hf" | None


# ── Dependency installer ──────────────────────────────────────────────────────
def _pip_install(*packages, log=print) -> bool:
    import subprocess
    log(f"[Laya] Installing: {' '.join(packages)} …")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", *packages,
         "--quiet", "--no-warn-script-location"],
        capture_output=True, text=True,
    )
    if r.returncode != 0 and r.stderr:
        log(f"[Laya] pip warning: {r.stderr[:200]}")
    return r.returncode == 0


def _check_onnxruntime(log=print) -> bool:
    """Return True if onnxruntime is importable (not just installed)."""
    try:
        import onnxruntime as ort
        # Actually try to use it — catches DLL load errors
        ort.get_available_providers()
        return True
    except ImportError:
        _pip_install("onnxruntime", log=log)
        try:
            import onnxruntime as ort
            ort.get_available_providers()
            return True
        except Exception:
            return False
    except Exception:
        # DLL error — onnxruntime installed but broken
        return False


def _check_transformers(log=print) -> bool:
    try:
        import transformers  # noqa
        return True
    except ImportError:
        return _pip_install("transformers", "torch", "--index-url",
                            "https://download.pytorch.org/whl/cpu", log=log)


# ── Download via HuggingFace (with progress) ───────────────────────────────────
def _download_hf_model(model_id: str, cache_dir: Path, log=print) -> Path | None:
    """
    Download model from HuggingFace with visible progress.
    Returns local directory path, or None on failure.
    """
    try:
        from huggingface_hub import snapshot_download
        log(f"[Laya] Downloading '{model_id}' from HuggingFace…")
        log("[Laya] This is ~500–800 MB and happens only ONCE. Please wait…")

        local = snapshot_download(
            repo_id=model_id,
            cache_dir=str(cache_dir / "hf_cache"),
            local_dir=str(cache_dir / "hf"),
            local_dir_use_symlinks=False,
            ignore_patterns=["*.msgpack", "flax_model*", "tf_model*", "rust_model*"],
        )
        log(f"[Laya] Download complete: {local}")
        return Path(local)
    except ImportError:
        _pip_install("huggingface_hub", log=log)
        return _download_hf_model(model_id, cache_dir, log=log)
    except Exception as e:
        log(f"[Laya] HuggingFace download failed: {e}")
        return None


# ── ONNX export ───────────────────────────────────────────────────────────────
def _export_to_onnx(model_dir: Path, log=print) -> bool:
    """Export a HuggingFace model directory to ONNX. Returns True on success."""
    try:
        from optimum.onnxruntime import ORTModelForSequenceClassification
        log("[Laya] Exporting to ONNX format…")
        model = ORTModelForSequenceClassification.from_pretrained(
            str(model_dir), export=True, provider="CPUExecutionProvider",
        )
        model.save_pretrained(str(_MODELS_DIR))
        log(f"[Laya] ONNX export saved to {_MODELS_DIR}")
        return True
    except ImportError:
        ok = _pip_install("optimum[onnxruntime]", log=log)
        if ok:
            return _export_to_onnx(model_dir, log=log)
        return False
    except Exception as e:
        log(f"[Laya] ONNX export failed: {e} — will use transformers fallback.")
        return False


# ── Load: ONNX session ────────────────────────────────────────────────────────
def _load_onnx_session(log=print) -> bool:
    global _session, _tokenizer_, _backend
    try:
        import onnxruntime as ort
        from transformers import AutoTokenizer

        log("[Laya] Loading ONNX session…")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = min(4, (os.cpu_count() or 2))
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC

        sess = ort.InferenceSession(
            str(_ONNX_PATH),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        tok_dir = _TOKENIZER if _TOKENIZER.exists() else (_MODELS_DIR / "hf" / "tokenizer")
        tok_path = str(tok_dir) if tok_dir.exists() else _MODEL_ID
        tok = AutoTokenizer.from_pretrained(tok_path, local_files_only=tok_dir.exists())

        with _model_lock:
            _session    = sess
            _tokenizer_ = tok
            _backend    = "onnx"

        log("[Laya] ONNX model loaded. Fast local decisions active (~20ms).")
        return True
    except Exception as e:
        log(f"[Laya] ONNX session failed: {e}")
        return False


# ── Load: HuggingFace transformers fallback ────────────────────────────────────
def _load_hf_model(model_dir: Path, log=print) -> bool:
    global _hf_model, _tokenizer_, _backend
    try:
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        import torch

        log("[Laya] Loading via transformers (slower but works without ONNX)…")
        tok   = AutoTokenizer.from_pretrained(str(model_dir))
        model = AutoModelForSequenceClassification.from_pretrained(
            str(model_dir), torch_dtype=torch.float32,
        )
        model.eval()

        with _model_lock:
            _hf_model   = model
            _tokenizer_ = tok
            _backend    = "hf"

        log("[Laya] Transformers model loaded. Decisions active (~80-200ms).")
        return True
    except Exception as e:
        log(f"[Laya] Transformers load failed: {e}")
        return False


# ── Master load orchestrator ──────────────────────────────────────────────────
def _load_model(log=print) -> bool:
    global _loading, _load_failed

    with _model_lock:
        if _session is not None or _hf_model is not None:
            return True
        if _loading or _load_failed:
            return False
        _loading = True

    try:
        _MODELS_DIR.mkdir(parents=True, exist_ok=True)
        log("[Laya] Initializing local decision engine…")

        # ── Step 1: Try ONNX path (fastest) ───────────────────────────────────
        if _ONNX_PATH.exists() and _check_onnxruntime(log=log):
            if _load_onnx_session(log=log):
                return True

        # ── Step 2: Download model if not present ──────────────────────────────
        hf_dir = _MODELS_DIR / "hf"
        if not hf_dir.exists() or not any(hf_dir.iterdir()):
            downloaded = _download_hf_model(_MODEL_ID, _MODELS_DIR, log=log)
            if downloaded is None:
                log("[Laya] Download failed. Laya will not be available.")
                _load_failed = True
                return False
            hf_dir = downloaded

        # ── Step 3: Try to export to ONNX ─────────────────────────────────────
        if _check_onnxruntime(log=log) and not _ONNX_PATH.exists():
            exported = _export_to_onnx(hf_dir, log=log)
            if exported and _ONNX_PATH.exists():
                # Save tokenizer alongside
                try:
                    from transformers import AutoTokenizer
                    tok = AutoTokenizer.from_pretrained(str(hf_dir))
                    tok.save_pretrained(str(_TOKENIZER))
                except Exception:
                    pass
                if _load_onnx_session(log=log):
                    _READY_FILE.write_text("onnx")
                    return True

        # ── Step 4: Transformers fallback (always works, just slower) ──────────
        log("[Laya] Falling back to transformers inference…")
        if _check_transformers(log=log):
            if _load_hf_model(hf_dir, log=log):
                return True

        log("[Laya] All loading methods failed.")
        _load_failed = True
        return False

    except Exception as e:
        log(f"[Laya] Unexpected error during model load: {e}")
        _load_failed = True
        return False
    finally:
        _loading = False




# ── Inference ──────────────────────────────────────────────────────────────────
def _format_choice_prompt(state: str, question: str, options: list[str]) -> str:
    opts_str = " | ".join(f"[{o}]" for o in options)
    return f"State: {state}\nQuestion: {question}\nChoices: {opts_str}"


def _format_noul_prompt(state: str, question: str) -> str:
    return f"State: {state}\nQuestion (true/false): {question}"


def _format_score_prompt(state: str, question: str) -> str:
    return f"State: {state}\nScore this (0.0–1.0): {question}"


def decide(
    state: str,
    question: str,
    question_type: str = "choice",
    options: list[str] | None = None,
    log=None,
) -> dict[str, Any]:
    """
    Make a fast local decision using Laya.

    Returns dict with keys:
      answer     — chosen option / True|False / float score
      confidence — probability 0.0–1.0
      latency_ms — inference time
      method     — 'laya_onnx' | 'laya_hf' | 'heuristic'
    """
    t0 = time.monotonic()
    _log = log or print

    # Load model if not ready
    if _session is None and _hf_model is None:
        success = _load_model(log=_log)
        if not success:
            return _heuristic_fallback(state, question, question_type, options, t0)

    try:
        qt   = question_type.lower().strip()
        opts = options or []
        if qt == "choice":
            prompt = _format_choice_prompt(state, question, opts)
        elif qt == "noul":
            prompt = _format_noul_prompt(state, question)
            opts   = ["true", "false"]
        else:
            prompt = _format_score_prompt(state, question)
            opts   = []

        # ── ONNX path ──────────────────────────────────────────────────────────
        if _session is not None:
            import numpy as np
            with _model_lock:
                enc = _tokenizer_(
                    prompt, return_tensors="np",
                    truncation=True, max_length=512, padding=True,
                )
                inp_names = {i.name for i in _session.get_inputs()}
                inputs  = {k: v.astype(np.int64) if hasattr(v, 'astype') and v.dtype != np.int64 else v for k, v in enc.items() if k in inp_names}
                outputs = _session.run(None, inputs)
            logits = outputs[0][0]
            method = "laya_onnx"

        # ── HuggingFace fallback path ──────────────────────────────────────────
        elif _hf_model is not None:
            import torch, numpy as np
            with _model_lock:
                enc    = _tokenizer_(prompt, return_tensors="pt",
                                     truncation=True, max_length=512, padding=True)
                with torch.no_grad():
                    out = _hf_model(**enc)
                logits = out.logits[0].numpy()
            method = "laya_hf"

        else:
            return _heuristic_fallback(state, question, question_type, options, t0)

        # ── Decode logits ──────────────────────────────────────────────────────
        import numpy as np
        from scipy.special import softmax

        if qt == "noul":
            probs   = softmax(logits)
            is_true = bool(np.argmax(probs) == 0)
            return {"answer": is_true, "confidence": float(np.max(probs)),
                    "latency_ms": (time.monotonic() - t0) * 1000, "method": method}

        elif qt == "choice" and opts:
            n     = min(len(opts), len(logits))
            probs = softmax(logits[:n])
            best  = int(np.argmax(probs))
            return {"answer": opts[best], "confidence": float(probs[best]),
                    "all_probs": {o: float(p) for o, p in zip(opts, probs)},
                    "latency_ms": (time.monotonic() - t0) * 1000, "method": method}

        else:
            probs = softmax(logits)
            score = float(np.dot(probs, np.linspace(0, 1, len(probs))))
            return {"answer": round(score, 3), "confidence": float(np.max(probs)),
                    "latency_ms": (time.monotonic() - t0) * 1000, "method": method}

    except Exception as e:
        _log(f"[Laya] Inference error: {e}")
        return _heuristic_fallback(state, question, question_type, options, t0)



def _heuristic_fallback(state, question, qt, options, t0) -> dict:
    """Ultra-fast keyword heuristic when Laya isn't loaded yet."""
    state_low = state.lower()
    q_low     = question.lower()

    if qt == "noul":
        # Simple keyword signals
        negative = any(w in state_low for w in
                       ["game over", "died", "fail", "error", "crash", "dead", "lost"])
        answer   = negative
        return {
            "answer": answer, "confidence": 0.6,
            "latency_ms": (time.monotonic() - t0) * 1000,
            "method": "heuristic",
        }

    elif qt == "choice" and options:
        # Return first option as safe fallback
        return {
            "answer": options[0], "confidence": 0.3,
            "latency_ms": (time.monotonic() - t0) * 1000,
            "method": "heuristic",
        }

    return {
        "answer": None, "confidence": 0.0,
        "latency_ms": (time.monotonic() - t0) * 1000,
        "method": "heuristic",
    }


def preload(log=print) -> bool:
    """Pre-load model in background thread. Call at startup to warm up."""
    if _session is not None or _hf_model is not None:
        return True
    if _load_failed:
        return False
    t = threading.Thread(target=_load_model, args=(log,), daemon=True, name="LayaPreload")
    t.start()
    return True


def is_ready() -> bool:
    return _session is not None or _hf_model is not None


def backend() -> str | None:
    return _backend


# ── TOOL run function (called by action_loader) ───────────────────────────────
def run(parameters: dict = None, args: dict = None, ctx: dict = None, player=None, speak=None, response=None, session_memory=None, **kwargs) -> str:
    #兼容 both new action_loader (parameters=..., player=...) and legacy (args, ctx) calls
    if parameters is None:
        parameters = args or {}
    if ctx is None:
        ctx = {}
        if player is not None:
            ctx["player"] = player
    # also merge kwargs player if passed via **kwargs
    if player is not None and "player" not in ctx:
        ctx["player"] = player
    params = parameters or {}
    state    = (params.get("state") or "").strip()
    question = (params.get("question") or "").strip()
    qt       = (params.get("question_type") or "choice").strip()
    options  = params.get("options") or []

    if not state or not question:
        return "laya_decide: 'state' and 'question' are required."

    player = ctx.get("player")
    def _log(m):
        print(m)
        if player:
            try: player.write_log(m)
            except Exception: pass

    result = decide(state, question, qt, options, log=_log)

    answer = result.get("answer")
    conf   = result.get("confidence", 0)
    ms     = result.get("latency_ms", 0)
    method = result.get("method", "?")

    return (
        f"Laya decision ({method}, {ms:.0f}ms): "
        f"answer={answer!r} confidence={conf:.2f}"
    )


# ── register handler for core.action_loader (must be after run is defined) ─────
TOOL["handler"] = run
