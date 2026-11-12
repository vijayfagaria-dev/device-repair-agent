"""The failpoint helper (P8-T03) must be inert unless NODE_ENV=test AND the point is named in FAILPOINTS.
(Port of server/test/chaos/failpoints.test.ts.)"""

from __future__ import annotations

import os
import signal
from unittest.mock import patch

import pytest

from app.failpoints import failpoint


def kills(name: str, *, node_env: str = "test", failpoints: str = "") -> bool:
    with (
        patch.dict(os.environ, {"NODE_ENV": node_env, "FAILPOINTS": failpoints}),
        patch("app.failpoints.os.kill") as kill,
    ):
        failpoint(name)
    if kill.called:
        kill.assert_called_once_with(os.getpid(), signal.SIGKILL)
    return bool(kill.called)


def test_kills_the_process_sigkill_only_for_a_named_point_in_node_env_test():
    assert kills("finalize.beforeCommit", failpoints="finalize.beforeCommit") is True
    assert kills("finalize.afterCommit", failpoints="a.b,finalize.afterCommit,c.d") is True


def test_does_nothing_for_another_point_an_empty_list_or_a_partial_name():
    assert kills("finalize.afterCommit", failpoints="finalize.beforeCommit") is False
    assert kills("finalize.beforeCommit", failpoints="") is False
    assert kills("finalize.beforeCommit", failpoints="finalize") is False


@pytest.mark.parametrize("node_env", ["production", "development"])
def test_is_inert_outside_node_env_test_even_when_armed(node_env: str):
    assert kills("finalize.beforeCommit", node_env=node_env, failpoints="finalize.beforeCommit") is False
