"""
daily_task_agent.py — 24/7 Autonomous Task Scheduler for MARK LIII
===================================================================
Jarvis can now run tasks completely on its own, any time of day or night.

You can tell Jarvis (by voice or chat):
  "Every morning at 9am check my email and summarize it"
  "At 2pm every day, open my project folder and remind me what I was working on"
  "Run this task now and also every weekday at 8am"
  "Stop the email task"

How it works
------------
Tasks are stored in memory/daily_tasks.json and loaded at startup.
A background scheduler thread checks the queue every 30 seconds.
When a task is due, it hands off to pc_agent / fast_agent / game_agent.
Results are stored in memory and spoken when you wake Jarvis.

TOOL dict — auto-discovered by core.action_loader.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


# ── TOOL declarations ─────────────────────────────────────────────────────────

TOOL = {
    "name": "schedule_task",
    "description": (
        "Schedule a task for Jarvis to do autonomously — now, later, or on a repeating schedule. "
        "Jarvis will execute it even while you're away. "
        "Examples: "
        "'run this every morning at 9am', "
        "'do this once at 3pm today', "
        "'check my emails every hour', "
        "'open my browser and check the weather every morning at 7am', "
        "'every 30 minutes remind me to drink water by playing a sound'."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "task":  {
                "type": "STRING",
                "description": "What Jarvis should do. Be specific.",
            },
            "schedule": {
                "type": "STRING",
                "description": (
                    "When to run. Examples: "
                    "'now', 'in 10 minutes', 'at 9:00am', "
                    "'every day at 8am', 'every hour', 'every 30 minutes', "
                    "'weekdays at 9am', 'once at 14:30'."
                ),
            },
            "name": {
                "type": "STRING",
                "description": "Short name to identify this task (e.g. 'morning_email')",
            },
            "app": {
                "type": "STRING",
                "description": "(Optional) App or URL to open before running the task.",
            },
        },
        "required": ["task", "schedule"],
    },
}

TOOL_LIST = {
    "name": "list_tasks",
    "description": "List all currently scheduled autonomous tasks.",
    "parameters": {"type": "OBJECT", "properties": {}, "required": []},
}

TOOL_CANCEL = {
    "name": "cancel_task",
    "description": "Cancel a scheduled autonomous task by name or ID.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "name": {"type": "STRING", "description": "Task name or ID to cancel."},
        },
        "required": ["name"],
    },
}

# Export all tools for action_loader
TOOLS = [TOOL, TOOL_LIST, TOOL_CANCEL]


# ── Paths ─────────────────────────────────────────────────────────────────────
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


_TASKS_FILE = _base_dir() / "memory" / "daily_tasks.json"
_LOG_FILE   = _base_dir() / "memory" / "task_log.json"


# ══════════════════════════════════════════════════════════════════════════════
# Schedule parsing
# ══════════════════════════════════════════════════════════════════════════════

def _parse_schedule(schedule_str: str) -> dict:
    """
    Convert a natural language schedule string into a structured dict.

    Returns:
        {
            "type":     "once" | "interval" | "daily" | "weekday",
            "next_run": ISO timestamp,
            "interval_sec": int | None,
            "time_str":  "09:00" | None,
            "days":     ["mon","tue",...] | None,
        }
    """
    s     = schedule_str.lower().strip()
    now   = datetime.now()
    result: dict[str, Any] = {
        "type": "once",
        "next_run": None,
        "interval_sec": None,
        "time_str": None,
        "days": None,
        "raw": schedule_str,
    }

    # "now" or "immediately"
    if s in ("now", "immediately", "right now", "asap"):
        result["next_run"] = now.isoformat()
        return result

    # "in X minutes/hours"
    m = re.search(r"in\s+(\d+)\s*(min|minute|hour|sec|second)", s)
    if m:
        qty  = int(m.group(1))
        unit = m.group(2)
        secs = {"sec": 1, "second": 1, "min": 60, "minute": 60, "hour": 3600}[unit]
        result["next_run"] = (now + timedelta(seconds=qty * secs)).isoformat()
        return result

    # "every X minutes/hours"
    m = re.search(r"every\s+(\d+)\s*(min|minute|hour|sec|second)", s)
    if m:
        qty  = int(m.group(1))
        unit = m.group(2)
        secs = {"sec": 1, "second": 1, "min": 60, "minute": 60, "hour": 3600}[unit]
        result["type"]         = "interval"
        result["interval_sec"] = qty * secs
        result["next_run"]     = now.isoformat()
        return result

    # "every hour"
    if "every hour" in s:
        result["type"]         = "interval"
        result["interval_sec"] = 3600
        result["next_run"]     = now.isoformat()
        return result

    # "every day at HH:MM" / "daily at HH:MM" / "every morning at HH:MM"
    time_match = re.search(r"(\d{1,2}):?(\d{2})?\s*(am|pm)?", s)
    if time_match:
        hour   = int(time_match.group(1))
        minute = int(time_match.group(2) or 0)
        ampm   = time_match.group(3)
        if ampm == "pm" and hour < 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0

        # Is it repeating or once?
        if any(w in s for w in ["every", "daily", "morning", "night", "evening",
                                  "afternoon", "weekday", "weekend"]):
            result["type"]     = "daily"
            result["time_str"] = f"{hour:02d}:{minute:02d}"

            # Weekday restriction
            if "weekday" in s or "workday" in s:
                result["days"] = ["mon", "tue", "wed", "thu", "fri"]
            elif "weekend" in s:
                result["days"] = ["sat", "sun"]
        else:
            result["type"] = "once"

        # Compute next_run
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        result["next_run"] = target.isoformat()
        return result

    # Fallback: run now
    result["next_run"] = now.isoformat()
    return result


def _next_run_after(schedule: dict) -> str:
    """Compute next_run timestamp after a task has just executed."""
    s_type  = schedule.get("type", "once")
    now     = datetime.now()

    if s_type == "once":
        return (now + timedelta(days=36500)).isoformat()  # far future = done

    elif s_type == "interval":
        secs = schedule.get("interval_sec", 3600)
        return (now + timedelta(seconds=secs)).isoformat()

    elif s_type in ("daily", "weekday"):
        time_str = schedule.get("time_str", "09:00")
        hh, mm   = map(int, time_str.split(":"))
        target   = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)

        # Skip to allowed day
        allowed_days = schedule.get("days")
        if allowed_days:
            day_map = {"mon":0,"tue":1,"wed":2,"thu":3,"fri":4,"sat":5,"sun":6}
            allowed = [day_map[d] for d in allowed_days if d in day_map]
            for _ in range(14):
                if target.weekday() in allowed:
                    break
                target += timedelta(days=1)

        return target.isoformat()

    return (now + timedelta(hours=1)).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# Task store
# ══════════════════════════════════════════════════════════════════════════════

class TaskStore:
    def __init__(self):
        self._lock  = threading.Lock()
        self._tasks: dict[str, dict] = {}
        self._load()

    def _load(self):
        try:
            if _TASKS_FILE.exists():
                data = json.loads(_TASKS_FILE.read_text(encoding="utf-8"))
                self._tasks = data if isinstance(data, dict) else {}
        except Exception:
            self._tasks = {}

    def _save(self):
        try:
            _TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
            _TASKS_FILE.write_text(
                json.dumps(self._tasks, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as e:
            print(f"[TaskStore] Save error: {e}")

    def add(self, task_id: str, task_def: dict):
        with self._lock:
            self._tasks[task_id] = task_def
            self._save()

    def remove(self, task_id: str) -> bool:
        with self._lock:
            if task_id in self._tasks:
                del self._tasks[task_id]
                self._save()
                return True
            return False

    def update_next_run(self, task_id: str, next_run: str):
        with self._lock:
            if task_id in self._tasks:
                self._tasks[task_id]["schedule"]["next_run"] = next_run
                self._tasks[task_id]["last_run"] = datetime.now().isoformat()
                self._save()

    def due_tasks(self) -> list[dict]:
        with self._lock:
            now = datetime.now().isoformat()
            return [
                {"id": tid, **t}
                for tid, t in self._tasks.items()
                if t.get("schedule", {}).get("next_run", "9999") <= now
                and not t.get("running", False)
            ]

    def set_running(self, task_id: str, running: bool):
        with self._lock:
            if task_id in self._tasks:
                self._tasks[task_id]["running"] = running

    def all_tasks(self) -> dict:
        with self._lock:
            return dict(self._tasks)


# ══════════════════════════════════════════════════════════════════════════════
# Task executor
# ══════════════════════════════════════════════════════════════════════════════

def _execute_task(task: dict, ctx: dict, log):
    """Run a single scheduled task using pc_agent."""
    task_desc = task.get("task", "")
    app_hint  = task.get("app", "")
    log(f"[Scheduler] Running: {task.get('name', task['id'])}")

    try:
        # Use pc_agent for general tasks
        from actions.pc_agent import run as _pc_run
        result = _pc_run(
            args={"task": task_desc, "app": app_hint, "max_steps": 15},
            ctx=ctx,
        )
        log(f"[Scheduler] Done: {result[:120]}")
        _append_log(task["id"], task_desc, result, success=True)
        return result
    except Exception as e:
        err = f"Task failed: {e}"
        log(f"[Scheduler] {err}")
        _append_log(task["id"], task_desc, err, success=False)
        return err


def _append_log(task_id: str, task_desc: str, result: str, success: bool):
    try:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        logs = []
        if _LOG_FILE.exists():
            logs = json.loads(_LOG_FILE.read_text(encoding="utf-8"))
        logs.append({
            "task_id":   task_id,
            "task":      task_desc[:100],
            "result":    result[:200],
            "success":   success,
            "timestamp": datetime.now().isoformat(),
        })
        # Keep last 200 entries
        logs = logs[-200:]
        _LOG_FILE.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════════════
# Background scheduler
# ══════════════════════════════════════════════════════════════════════════════

class _Scheduler:
    TICK = 30  # check every 30 seconds

    def __init__(self):
        self._store   = TaskStore()
        self._ctx: dict = {}
        self._running = False
        self._thread: threading.Thread | None = None
        self._log     = print

    def start(self, ctx: dict, log=print):
        self._ctx = ctx
        self._log = log
        if not self._running:
            self._running = True
            self._thread  = threading.Thread(
                target=self._loop, daemon=True, name="JarvisScheduler"
            )
            self._thread.start()
            n = len(self._store.all_tasks())
            log(f"[Scheduler] Started — {n} task(s) loaded.")

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                due = self._store.due_tasks()
                for task in due:
                    tid = task["id"]
                    self._store.set_running(tid, True)
                    threading.Thread(
                        target=self._run_one,
                        args=(task,),
                        daemon=True,
                        name=f"Task-{tid}",
                    ).start()
            except Exception as e:
                self._log(f"[Scheduler] Loop error: {e}")
            time.sleep(self.TICK)

    def _run_one(self, task: dict):
        tid = task["id"]
        try:
            result = _execute_task(task, self._ctx, self._log)
            sched  = task.get("schedule", {})
            next_r = _next_run_after(sched)
            self._store.update_next_run(tid, next_r)
            # If one-time and far future, remove it
            if sched.get("type") == "once":
                self._store.remove(tid)

            # Notify via speak if available
            speak = self._ctx.get("speak")
            if speak and task.get("notify_on_complete", True):
                name = task.get("name", "scheduled task")
                speak(f"Completed: {name}. {result[:80] if result else ''}")
        except Exception as e:
            self._log(f"[Scheduler] Task {tid} error: {e}")
        finally:
            self._store.set_running(tid, False)

    def add_task(self, task_id: str, task_def: dict):
        self._store.add(task_id, task_def)

    def remove_task(self, name_or_id: str) -> bool:
        # Try by ID first
        if self._store.remove(name_or_id):
            return True
        # Try by name
        for tid, t in self._store.all_tasks().items():
            if t.get("name", "").lower() == name_or_id.lower():
                return self._store.remove(tid)
        return False

    def list_tasks(self) -> list[dict]:
        tasks = self._store.all_tasks()
        result = []
        for tid, t in tasks.items():
            next_r = t.get("schedule", {}).get("next_run", "")
            try:
                dt     = datetime.fromisoformat(next_r)
                in_sec = (dt - datetime.now()).total_seconds()
                if in_sec < 0:
                    when = "due now"
                elif in_sec < 3600:
                    when = f"in {int(in_sec//60)}m"
                elif in_sec < 86400:
                    when = f"in {int(in_sec//3600)}h"
                else:
                    when = dt.strftime("%Y-%m-%d %H:%M")
            except Exception:
                when = next_r

            result.append({
                "id":       tid,
                "name":     t.get("name", tid),
                "task":     t.get("task", "")[:60],
                "schedule": t.get("schedule", {}).get("raw", ""),
                "next_run": when,
                "running":  t.get("running", False),
            })
        return result

    def get_recent_results(self, n: int = 5) -> list[dict]:
        try:
            if _LOG_FILE.exists():
                logs = json.loads(_LOG_FILE.read_text(encoding="utf-8"))
                return logs[-n:]
        except Exception:
            pass
        return []


# ── Singleton ──────────────────────────────────────────────────────────────────
_scheduler: _Scheduler | None = None


def get_scheduler() -> _Scheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = _Scheduler()
    return _scheduler


def start_scheduler(ctx: dict, log=print):
    """Called from main.py run() to start the background scheduler."""
    sch = get_scheduler()
    sch.start(ctx=ctx, log=log)
    return sch


# ══════════════════════════════════════════════════════════════════════════════
# TOOL run functions (called by action_loader)
# ══════════════════════════════════════════════════════════════════════════════

import uuid as _uuid

def run(args: dict, ctx: dict) -> str:
    """Handle schedule_task tool call."""
    task_desc = (args.get("task") or "").strip()
    schedule  = (args.get("schedule") or "now").strip()
    name      = (args.get("name") or task_desc[:30]).strip()
    app       = (args.get("app") or "").strip()

    if not task_desc:
        return "No task specified."

    parsed = _parse_schedule(schedule)
    tid    = _uuid.uuid4().hex[:8]

    task_def = {
        "id":       tid,
        "name":     name,
        "task":     task_desc,
        "app":      app,
        "schedule": parsed,
        "created":  datetime.now().isoformat(),
        "notify_on_complete": True,
        "running":  False,
    }

    sch = get_scheduler()
    sch.add_task(tid, task_def)

    # Start scheduler if not running (lazy start)
    if not sch._running:
        sch.start(ctx=ctx, log=print)

    stype  = parsed.get("type", "once")
    next_r = parsed.get("next_run", "")
    try:
        dt   = datetime.fromisoformat(next_r)
        when = "now" if (dt - datetime.now()).total_seconds() < 5 else dt.strftime("%H:%M on %b %d")
    except Exception:
        when = schedule

    if stype == "interval":
        secs = parsed.get("interval_sec", 3600)
        freq = f"every {secs//60}min" if secs < 3600 else f"every {secs//3600}h"
        return (
            f"Scheduled '{name}' to run {freq}, starting {when}. "
            f"Task ID: {tid}. I'll do this automatically even while you're away."
        )
    elif stype in ("daily", "weekday"):
        days = "weekdays" if parsed.get("days") else "daily"
        return (
            f"Scheduled '{name}' to run {days} at {parsed.get('time_str', when)}. "
            f"Task ID: {tid}. I'll handle this every day automatically."
        )
    else:
        return (
            f"Scheduled '{name}' to run {when}. "
            f"Task ID: {tid}."
        )


def run_list(args: dict, ctx: dict) -> str:
    """Handle list_tasks tool call."""
    tasks = get_scheduler().list_tasks()
    if not tasks:
        return "No scheduled tasks. Tell me what you'd like me to do automatically!"

    lines = ["Scheduled tasks:"]
    for t in tasks:
        status = "⟳ RUNNING" if t["running"] else f"next: {t['next_run']}"
        lines.append(f"  [{t['id']}] {t['name']} — {t['task'][:40]} | {t['schedule']} | {status}")
    return "\n".join(lines)


def run_cancel(args: dict, ctx: dict) -> str:
    """Handle cancel_task tool call."""
    name = (args.get("name") or "").strip()
    if not name:
        return "Specify the task name or ID to cancel."
    ok = get_scheduler().remove_task(name)
    return f"Task '{name}' cancelled." if ok else f"No task named '{name}' found."


# Register multiple tools under this module
TOOL_RUNNERS = {
    "schedule_task": run,
    "list_tasks":    run_list,
    "cancel_task":   run_cancel,
}
