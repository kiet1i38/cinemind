"""HTTP routes for anonymous interaction persistence."""

from collections.abc import Iterator
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status

from cinemind.auth.dependencies import AuthContext, get_optional_auth_context, require_auth_context
from cinemind.config import get_settings
from cinemind.db.connection import connection_scope
from cinemind.interaction.repository import InteractionRepository
from cinemind.interaction.schemas import (
    InteractionStateResponse,
    RatingCreateRequest,
    RatingResponse,
    SearchEventCreateRequest,
    SearchEventResponse,
    SessionCreateRequest,
    SessionResponse,
    SignalCreateRequest,
    SignalResponse,
    WatchSessionCreateRequest,
    WatchSessionResponse,
)
from cinemind.interaction.service import (
    InteractionConflictError,
    InteractionNotFoundError,
    InteractionService,
    InteractionUnauthorizedError,
    InteractionValidationError,
)


def enforce_interaction_rate_limit(request: Request) -> None:
    """Compatibility hook; request limiting is handled after response status."""

    return None


router = APIRouter(
    prefix="/api/interaction",
    tags=["interaction"],
)


def get_interaction_service() -> Iterator[InteractionService]:
    """Create one repository connection per interaction request."""

    settings = get_settings()
    with connection_scope(settings) as connection:
        yield InteractionService(InteractionRepository(connection), settings)


@router.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreateRequest,
    auth: AuthContext | None = Depends(get_optional_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> SessionResponse:
    """Create a browser session, linked to the account when signed in."""

    return SessionResponse(**service.create_session(
        payload.locale,
        payload.platform,
        auth.user_id if auth else None,
    ))


@router.post("/search-events", response_model=SearchEventResponse, status_code=status.HTTP_201_CREATED)
def create_search_event(
    payload: SearchEventCreateRequest,
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext | None = Depends(get_optional_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> SearchEventResponse:
    """Store a debounced search event."""

    try:
        return SearchEventResponse(**service.record_search_event(
            payload.session_id,
            payload.query,
            payload.result_count,
            payload.filters,
            auth.user_id if auth else None,
            session_token,
            payload.client_mutation_id,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except InteractionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/watch-sessions", response_model=WatchSessionResponse, status_code=status.HTTP_201_CREATED)
def create_watch_session(
    payload: WatchSessionCreateRequest,
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext = Depends(require_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> WatchSessionResponse:
    """Store a normalized watch-duration event."""

    try:
        return WatchSessionResponse(**service.record_watch_session(
            payload.session_id,
            payload.show_id,
            payload.watch_minutes,
            auth.user_id,
            session_token,
            payload.client_mutation_id,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except InteractionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/ratings", response_model=RatingResponse, status_code=status.HTTP_201_CREATED)
def create_rating(
    payload: RatingCreateRequest,
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext = Depends(require_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> RatingResponse:
    """Store a rating event."""

    try:
        return RatingResponse(**service.record_rating(
            payload.session_id,
            payload.show_id,
            payload.rating,
            payload.watch_session_id,
            auth.user_id,
            session_token,
            payload.client_mutation_id,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except InteractionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/signals", response_model=SignalResponse, status_code=status.HTTP_201_CREATED)
def create_signal(
    payload: SignalCreateRequest,
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext = Depends(require_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> SignalResponse:
    """Persist watch duration and rating in one transaction."""

    try:
        return SignalResponse(**service.record_signal(
            payload.session_id,
            payload.show_id,
            payload.rating,
            payload.watch_minutes,
            auth.user_id,
            session_token,
            payload.client_mutation_id,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except InteractionConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/state", response_model=InteractionStateResponse)
def get_interaction_state(
    session_id: UUID = Query(...),
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext | None = Depends(get_optional_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> InteractionStateResponse:
    """Restore latest ratings for a session."""

    try:
        return InteractionStateResponse(**service.get_state(session_id, auth.user_id if auth else None, session_token))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error


@router.get("/state/{session_id}", response_model=InteractionStateResponse)
def get_interaction_state_by_path(
    session_id: UUID,
    session_token: str | None = Header(default=None, alias="X-Cinemind-Session-Token", min_length=20, max_length=256),
    auth: AuthContext | None = Depends(get_optional_auth_context),
    service: InteractionService = Depends(get_interaction_service),
) -> InteractionStateResponse:
    """Path-based state restore for hosts that filter session query keys."""

    try:
        return InteractionStateResponse(**service.get_state(session_id, auth.user_id if auth else None, session_token))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionUnauthorizedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
