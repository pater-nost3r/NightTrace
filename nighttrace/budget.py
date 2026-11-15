"""A per-request time budget shared by every archive call made while serving one request.

Vercel stops a function at its maxDuration (60 s here). Each API request runs under a
deadline below that limit; every network call takes its timeout from the time that is
left, and retries happen only while time remains. When the budget is spent the call
fails with a controlled "timeout" error instead of the platform killing the function.
"""
from __future__ import annotations

import contextlib
import contextvars
import time

REQUEST_SECONDS = 50.0      # below the 60 s maxDuration in vercel.json
MIN_CALL_SECONDS = 1.0      # do not start a network call with less time than this
_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar("nighttrace_deadline", default=None)


@contextlib.contextmanager
def limit(seconds: float = REQUEST_SECONDS):
    """Run the block under a deadline (nested limits can only shorten it)."""
    end = time.monotonic() + seconds
    current = _deadline.get()
    token = _deadline.set(end if current is None else min(current, end))
    try:
        yield
    finally:
        _deadline.reset(token)


def remaining() -> float | None:
    end = _deadline.get()
    return None if end is None else end - time.monotonic()


def call_timeout(default: float) -> float | None:
    """Timeout for the next network call, or None when there is no time left for one."""
    left = remaining()
    if left is None:
        return default
    if left < MIN_CALL_SECONDS:
        return None
    return min(default, left - 0.25)


def can_wait(seconds: float) -> bool:
    left = remaining()
    return left is None or left - seconds >= MIN_CALL_SECONDS


def expired() -> bool:
    left = remaining()
    return left is not None and left <= 0


def submit(pool, fn, *args):
    """ThreadPoolExecutor.submit that carries the caller's deadline into the worker thread."""
    return pool.submit(contextvars.copy_context().run, fn, *args)
