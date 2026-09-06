"""Use cases for safe, explicit database reset operations."""

from datetime import datetime, timezone

from cinemind.config import Settings
from cinemind.admin.repository import ResetRepository
from cinemind.admin.schemas import ResetRequest, ResetScope
from cinemind.scripts.bootstrap_catalog import bootstrap_catalog


_CONFIRMATION_PHRASES = {
    ResetScope.INTERACTION: "RESET CURRENT SESSION",
    ResetScope.DEMO: "RESET DEMO DATA",
    ResetScope.FULL: "RESET FULL DATABASE",
}


class ResetValidationError(ValueError):
    """Raised when the reset request does not match its safety contract."""


class ResetExecutionError(RuntimeError):
    """Raised when a full reset cannot rebuild the catalog."""


class ResetService:
    """Coordinate reset scope, transaction boundaries, and catalog reseeding."""

    def __init__(self, repository: ResetRepository, settings: Settings):
        self.repository = repository
        self.settings = settings

    def reset(self, request: ResetRequest) -> dict:
        """Execute one explicitly confirmed reset scope."""

        self._validate_request(request)
        if request.scope is ResetScope.INTERACTION:
            return self._reset_current_session(request)
        if request.scope is ResetScope.DEMO:
            return self._reset_demo_data(request)
        return self._reset_full_database(request)

    def _reset_current_session(self, request: ResetRequest) -> dict:
        if request.session_id is None:
            raise ResetValidationError("session_id is required for the interaction scope")
        with self.repository.transaction():
            deleted = self.repository.delete_session_interactions(request.session_id)
        return self._response(request.scope, deleted)

    def _reset_demo_data(self, request: ResetRequest) -> dict:
        with self.repository.transaction():
            deleted = self.repository.delete_all_interactions()
        return self._response(request.scope, deleted)

    def _reset_full_database(self, request: ResetRequest) -> dict:
        with self.repository.transaction():
            deleted = self.repository.delete_all_application_data()

        try:
            bootstrap_result = bootstrap_catalog(self.settings)
        except Exception as error:
            raise ResetExecutionError(
                "The database was cleared but the catalog could not be reseeded"
            ) from error

        return self._response(
            request.scope,
            deleted,
            catalog_reseeded=True,
            seeded_catalog_rows=int(bootstrap_result["rows_loaded"]),
            catalog_summary=bootstrap_result["catalog_summary"],
        )

    @staticmethod
    def confirmation_phrase(scope: ResetScope) -> str:
        """Return the exact phrase required by the UI and API contract."""

        return _CONFIRMATION_PHRASES[scope]

    def _validate_request(self, request: ResetRequest) -> None:
        if request.confirmation.strip() != self.confirmation_phrase(request.scope):
            raise ResetValidationError("The confirmation phrase does not match the selected scope")
        if request.scope is ResetScope.INTERACTION and request.session_id is None:
            raise ResetValidationError("session_id is required for the interaction scope")
        if request.scope is ResetScope.FULL and not self.settings.full_reset_enabled:
            raise ResetValidationError("Full database reset is disabled")

    @staticmethod
    def _response(
        scope: ResetScope,
        deleted: dict[str, int],
        *,
        catalog_reseeded: bool = False,
        seeded_catalog_rows: int = 0,
        catalog_summary: dict[str, int] | None = None,
    ) -> dict:
        return {
            "scope": scope,
            "reset_at": datetime.now(timezone.utc),
            "deleted_rows": deleted,
            "catalog_reseeded": catalog_reseeded,
            "seeded_catalog_rows": seeded_catalog_rows,
            "catalog_summary": catalog_summary,
        }
