"""
pc_agent.py — Autonomous PC Agent for MARK LIII
================================================
Sees the screen → reasons about what to do next → clicks/types/scrolles until
the task is done. Uses Gemini Vision (non-live) for perception and PyAutoGUI for
execution. Integrates with the existing screen_processor + computer_control modules.

TOOL dict makes it self-describing — auto-discovered by core.action_loader at launch.
"""

import base64
import json
import platform
import re
import sys
import time
from pathlib import Path

# ── Optional imports ──────────────────────────────────────────────────────────
try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE    = 0.3     # safety delay between actions
    _PYAUTOGUI = True
except ImportError:
    _PYAUTOGUI = False

_SYSTEM = platform.system()

# ── Tool declaration — auto-discovered by core.action_loader ──────────────────
TOOL = {
    "name": "pc_agent",
    "description": (
        "Autonomously complete a multi-step task on the PC by seeing the screen "
        "and controlling the mouse and keyboard. "
        "Use when the user says things like: "
        "'open Spotify and play lo-fi beats', "
        "'fill in this form', "
        "'navigate to settings and turn on dark mode', "
        "'do X in Y app'. "
        "The agent sees the screen after each action and decides what to do next. "
        "It runs up to 15 steps before stopping."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "task": {
                "type": "STRING",
                "description": "High-level description of what to accomplish on the PC.",
            },
            "app": {
                "type": "STRING",
                "description": "(Optional) Name of the application to focus/open first.",
            },
            "max_steps": {
                "type": "INTEGER",
                "description": "Maximum number of actions to take. Default: 12. Max: 15.",
            },
        },
        "required": ["task"],
    },
}


# ── Config helpers ─────────────────────────────────────────────────────────────
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


_CONFIG_PATH = _base_dir() / "config" / "api_keys.json"


def _get_api_key() -> str:
    # Try multi-key manager first (uses all configured keys in rotation)
    try:
        from core.multi_key_manager import get_key
        k = get_key()
        if k:
            return k
    except Exception:
        pass
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8")).get("gemini_api_key", "")
    except Exception:
        return ""


# ── Screen capture ─────────────────────────────────────────────────────────────
def _take_screenshot() -> tuple[bytes, str]:
    """Capture screen and return (jpeg_bytes, mime_type)."""
    try:
        from actions.screen_processor import _capture_screen
        return _capture_screen()
    except Exception:
        pass
    # Fallback: pyautogui screenshot
    if _PYAUTOGUI:
        import io
        try:
            img = pyautogui.screenshot()
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=65)
            return buf.getvalue(), "image/jpeg"
        except Exception:
            pass
    return b"", "image/jpeg"


# ── Gemini Vision (non-live) call ──────────────────────────────────────────────
_VISION_SYSTEM = """You are an autonomous PC control agent. You are given:
1. A task description
2. The current screen state (screenshot)
3. A history of actions already taken

Respond with EXACTLY a JSON object (no markdown, no explanation) with this structure:
{
  "done": false,
  "reason": "why done or why continuing",
  "action": "one of: click | type | key | scroll | open_app | wait | done",
  "params": {
    "x": 100,           (for click/scroll — screen pixel X)
    "y": 200,           (for click/scroll — screen pixel Y)
    "text": "hello",    (for type/key)
    "app": "chrome",    (for open_app)
    "direction": "down", (for scroll: up/down/left/right)
    "amount": 3         (for scroll: number of ticks)
  },
  "comment": "brief description of this action"
}

If done=true, set action="done" and explain in reason.
Only use x/y coordinates you can see clearly in the screenshot.
Be precise and conservative — prefer single clean actions.
For key presses: use pyautogui key names like "enter", "tab", "ctrl+c", "ctrl+v", "escape", "win".
"""


def _vision_decide(
    task: str,
    screenshot_b64: str,
    history: list[str],
    api_key: str,
) -> dict:
    """Call Gemini Vision to decide the next action."""
    try:
        from google import genai
        from google.genai import types as gtypes

        client = genai.Client(api_key=api_key)

        history_str = ""
        if history:
            history_str = "\n\nActions taken so far:\n" + "\n".join(
                f"  {i+1}. {h}" for i, h in enumerate(history)
            )

        user_msg = (
            f"Task: {task}"
            + history_str
            + "\n\nCurrent screen state is shown in the image. "
            + "What is your next action? Respond ONLY with the JSON object."
        )

        resp = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[
                gtypes.Part.from_bytes(
                    data=base64.b64decode(screenshot_b64),
                    mime_type="image/jpeg",
                ),
                gtypes.Part.from_text(text=user_msg),
            ],
            config=gtypes.GenerateContentConfig(
                system_instruction=_VISION_SYSTEM,
                max_output_tokens=256,
                temperature=0.1,
            ),
        )
        raw = (resp.text or "").strip()
        # Strip markdown fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return json.loads(raw)
    except Exception as e:
        print(f"[PcAgent] Vision error: {e}")
        return {"done": True, "reason": f"Vision call failed: {e}", "action": "done", "params": {}}


# ── Action executor ────────────────────────────────────────────────────────────
def _execute_action(action: dict) -> str:
    """Execute a single action. Returns a human-readable description."""
    if not _PYAUTOGUI:
        return "PyAutoGUI not installed — cannot execute PC actions."

    act    = action.get("action", "done").lower().strip()
    params = action.get("params", {})

    try:
        if act == "click":
            x, y = int(params.get("x", 0)), int(params.get("y", 0))
            pyautogui.click(x, y)
            return f"Clicked ({x}, {y})"

        elif act == "type":
            text = params.get("text", "")
            pyautogui.typewrite(text, interval=0.04)
            return f"Typed: {text[:40]}"

        elif act == "key":
            keys = params.get("text", "enter")
            # Handle combos like "ctrl+c"
            if "+" in keys:
                parts = [k.strip() for k in keys.split("+")]
                pyautogui.hotkey(*parts)
            else:
                pyautogui.press(keys)
            return f"Key: {keys}"

        elif act == "scroll":
            x      = int(params.get("x", pyautogui.size()[0] // 2))
            y      = int(params.get("y", pyautogui.size()[1] // 2))
            amount = int(params.get("amount", 3))
            direction = params.get("direction", "down").lower()
            if direction == "down":
                pyautogui.scroll(-amount, x=x, y=y)
            elif direction == "up":
                pyautogui.scroll(amount, x=x, y=y)
            elif direction == "left":
                pyautogui.hscroll(-amount, x=x, y=y)
            elif direction == "right":
                pyautogui.hscroll(amount, x=x, y=y)
            return f"Scrolled {direction} at ({x}, {y})"

        elif act == "open_app":
            app = params.get("app", "")
            if app:
                # Reuse the existing open_app action
                try:
                    from actions.open_app import run as _run_open_app
                    _run_open_app({"app_name": app}, {})
                    time.sleep(1.5)
                    return f"Opened app: {app}"
                except Exception:
                    # Fallback: Win key + search
                    pyautogui.hotkey("win", "s")
                    time.sleep(0.5)
                    pyautogui.typewrite(app, interval=0.06)
                    time.sleep(0.8)
                    pyautogui.press("enter")
                    return f"Searched and launched: {app}"
            return "open_app: no app name given"

        elif act == "wait":
            secs = float(params.get("amount", 1.5))
            time.sleep(min(secs, 5.0))
            return f"Waited {secs:.1f}s"

        elif act == "done":
            return "Task complete."

        else:
            return f"Unknown action: {act}"

    except pyautogui.FailSafeException:
        return "STOP: PyAutoGUI failsafe triggered (mouse moved to corner)."
    except Exception as e:
        return f"Action failed ({act}): {e}"


# ── Main run function — called by action_loader ────────────────────────────────
def run(args: dict, ctx: dict) -> str:
    """
    Execute a multi-step autonomous PC task.

    Args:
        args: {"task": str, "app": str (optional), "max_steps": int (optional)}
        ctx:  JarvisLive context — ctx["speak"] and ctx["player"] available

    Returns:
        Summary string shown to Gemini / the user.
    """
    task      = (args.get("task") or "").strip()
    app_hint  = (args.get("app") or "").strip()
    max_steps = min(int(args.get("max_steps") or 12), 15)
    speak     = ctx.get("speak")
    player    = ctx.get("player")

    if not task:
        return "No task specified for pc_agent."

    if not _PYAUTOGUI:
        return (
            "PyAutoGUI is not installed. To enable PC autonomy, run: "
            "pip install pyautogui  —  then restart JARVIS."
        )

    api_key = _get_api_key()
    if not api_key:
        return "No Gemini API key found — cannot run vision decisions."

    def _log(msg: str):
        print(f"[PcAgent] {msg}")
        if player:
            try:
                player.write_log(f"[Agent] {msg}")
            except Exception:
                pass

    _log(f"Starting task: {task}")
    if speak:
        speak(f"Starting autonomous task: {task}. I'll work through it step by step.")

    # Step 0: open target app if given
    if app_hint:
        _log(f"Opening app: {app_hint}")
        try:
            from actions.open_app import run as _run_open_app
            _run_open_app({"app_name": app_hint}, {})
            time.sleep(2.0)
        except Exception as e:
            _log(f"Could not open {app_hint}: {e}")

    history: list[str] = []
    final_reason = "Completed."

    for step in range(1, max_steps + 1):
        _log(f"Step {step}/{max_steps} — capturing screen…")

        # Capture current screen
        img_bytes, _mime = _take_screenshot()
        if not img_bytes:
            _log("Screen capture failed.")
            break

        screenshot_b64 = base64.b64encode(img_bytes).decode("ascii")

        # Ask vision model what to do
        decision = _vision_decide(task, screenshot_b64, history, api_key)

        done     = bool(decision.get("done", False))
        action   = decision.get("action", "done")
        comment  = decision.get("comment", action)
        reason   = decision.get("reason", "")

        _log(f"Decision: {action} — {comment}")

        if done or action == "done":
            final_reason = reason or "Task complete."
            _log(f"Done: {final_reason}")
            break

        # Execute the action
        result = _execute_action(decision)
        history.append(f"{action}: {comment} → {result}")
        _log(f"Result: {result}")

        # Failsafe check
        if "STOP" in result or "failed" in result.lower():
            final_reason = f"Stopped: {result}"
            break

        # Short pause between actions
        time.sleep(0.5)

    steps_done = len(history)
    summary = (
        f"PC agent completed '{task}' in {steps_done} step(s). "
        f"Outcome: {final_reason}"
    )
    _log(summary)
    return summary
