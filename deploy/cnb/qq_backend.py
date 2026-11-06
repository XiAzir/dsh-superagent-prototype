"""Select one owned QQ bridge for the persistent CNB runtime."""
from __future__ import annotations

from typing import Any


class QQBackendError(RuntimeError):
    """The QQ bridge selection is ambiguous or could not be stopped safely."""


class QQBackend:
    """Reconcile NapCat or SnowLuma while keeping their account sessions exclusive."""

    def __init__(self, napcat: Any, snowluma: Any):
        self.managers = {'napcat': napcat, 'snowluma': snowluma}
        self.active: str | None = None

    def selection(self) -> str | None:
        enabled = [name for name, manager in self.managers.items() if manager.configured()]
        if len(enabled) > 1:
            raise QQBackendError('Enable one QQ bridge: NapCat or SnowLuma.')
        return enabled[0] if enabled else None

    def configured(self) -> bool:
        return self.selection() is not None

    def ensure_started(self) -> dict[str, Any]:
        selected = self.selection()
        if selected is None:
            if self.active:
                self.stop()
            return {'enabled': False, 'running': False, 'webui_ready': False, 'backend': None}
        # An inactive bridge may have been restored by Docker's restart policy.
        # Stop it before starting the selected bridge or binding its OneBot port.
        for name, manager in self.managers.items():
            if name != selected:
                manager.stop()
        self.active = selected
        return {**self.managers[selected].ensure_started(), 'backend': selected}

    def healthy(self) -> bool:
        selected = self.selection()
        if selected != self.active:
            return False
        return selected is None or bool(self.managers[selected].healthy())

    def stop(self, *, timeout: int = 30) -> bool:
        stopped = False
        failure = False
        for name, manager in self.managers.items():
            try:
                if name == self.active or manager.configured():
                    stopped = bool(manager.stop(timeout=timeout)) or stopped
            except Exception:
                failure = True
        if failure:
            raise QQBackendError('An owned QQ bridge could not be stopped; inspect its deployment state.')
        self.active = None
        return stopped
