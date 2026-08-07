"""Test isolation for the gateway suite.

Two module-level side effects in ``app.py`` decide what the whole suite touches:
``METRICS = Metrics()`` opens ``~/.cheaper/metrics.db`` and ``auth.ensure_token()``
mints ``~/.cheaper/dash.token``. Both run at IMPORT time, so the environment has to
be redirected before any test module imports ``app`` -- a fixture would be too late.

conftest.py is imported during collection, ahead of every test module, which makes
this the only correct place for it. Without it the suite would read and mutate the
developer's real usage database and could overwrite their live dashboard token.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

_TMP = Path(tempfile.mkdtemp(prefix="cheaper-gwtest-"))

# Redirect BOTH stores. `setdefault` so a caller that already pinned them (CI matrix,
# a focused debugging run) keeps their choice.
os.environ.setdefault("CHEAPER_DB", str(_TMP / "metrics.db"))
os.environ.setdefault("CHEAPER_TOKEN_FILE", str(_TMP / "dash.token"))
os.environ.setdefault("CHEAPER_EVENTS_DIR", str(_TMP / "events"))

import pytest  # noqa: E402


@pytest.fixture()
def gw_token() -> str:
    """The token the test gateway is enforcing. Tests attach it as the
    ``x-cheaper-token`` header; the query-string form is covered explicitly by the
    auth tests, because a browser navigating to /dashboard cannot set a header."""
    import auth  # noqa: WPS433 - deliberately late, after the env is redirected
    return auth.ensure_token()


@pytest.fixture()
def auth_headers(gw_token) -> dict:
    return {"x-cheaper-token": gw_token}
