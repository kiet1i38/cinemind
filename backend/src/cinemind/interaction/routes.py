"""HTTP routes for anonymous interaction persistence."""

from collections.abc import Iterator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from cinemind.config import get_settings
from cinemind.db.connection import connection_scope
from cinemind.interaction.repository import InteractionRepository
from cinemind.interaction.schemas import (
    InteractionStateResponse,
    PreferenceCreateRequest,
    PreferenceResponse,
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
    InteractionNotFoundError,
    InteractionService,
    InteractionValidationError,
)


router = APIRouter(prefix="/api/interaction", tags=["interaction"])


def get_interaction_service() -> Iterator[InteractionService]:
    """Create one repository connection per interaction request."""

    settings = get_settings()
    with connection_scope(settings) as connection:
        yield InteractionService(InteractionRepository(connection), settings)


@router.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> SessionResponse:
    """Create an anonymous persistence session."""

    return SessionResponse(**service.create_session(payload.locale, payload.platform))


@router.post("/search-events", response_model=SearchEventResponse, status_code=status.HTTP_201_CREATED)
def create_search_event(
    payload: SearchEventCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> SearchEventResponse:
    """Store a debounced search event."""

    try:
        return SearchEventResponse(**service.record_search_event(
            payload.session_id,
            payload.query,
            payload.result_count,
            payload.filters,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/watch-sessions", response_model=WatchSessionResponse, status_code=status.HTTP_201_CREATED)
def create_watch_session(
    payload: WatchSessionCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> WatchSessionResponse:
    """Store a normalized watch-duration event."""

    try:
        return WatchSessionResponse(**service.record_watch_session(
            payload.session_id,
            payload.show_id,
            payload.watch_minutes,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/ratings", response_model=RatingResponse, status_code=status.HTTP_201_CREATED)
def create_rating(
    payload: RatingCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> RatingResponse:
    """Store a rating event."""

    try:
        return RatingResponse(**service.record_rating(
            payload.session_id,
            payload.show_id,
            payload.rating,
            payload.watch_session_id,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/signals", response_model=SignalResponse, status_code=status.HTTP_201_CREATED)
def create_signal(
    payload: SignalCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> SignalResponse:
    """Persist watch duration and rating in one transaction."""

    try:
        return SignalResponse(**service.record_signal(
            payload.session_id,
            payload.show_id,
            payload.rating,
            payload.watch_minutes,
        ))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/favorites", response_model=PreferenceResponse, status_code=status.HTTP_201_CREATED)
def add_favorite(
    payload: PreferenceCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Add or restore a favorite title."""

    return _preference_response(service, "favorites", payload)


@router.delete("/favorites/{show_id}", response_model=PreferenceResponse)
def remove_favorite(
    show_id: str,
    session_id: UUID = Query(...),
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Soft-remove a favorite title; repeated removal is safe."""

    return _remove_preference_response(service, "favorites", session_id, show_id)


@router.delete("/favorites/{show_id}/{session_id}", response_model=PreferenceResponse)
def remove_favorite_by_path(
    show_id: str,
    session_id: UUID,
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Path-based favorite removal for hosts that filter session query keys."""

    return _remove_preference_response(service, "favorites", session_id, show_id)


@router.post("/watchlist-items", response_model=PreferenceResponse, status_code=status.HTTP_201_CREATED)
def add_watchlist_item(
    payload: PreferenceCreateRequest,
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Add or restore a watchlist title."""

    return _preference_response(service, "watchlist_items", payload)


@router.delete("/watchlist-items/{show_id}", response_model=PreferenceResponse)
def remove_watchlist_item(
    show_id: str,
    session_id: UUID = Query(...),
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Soft-remove a watchlist title; repeated removal is safe."""

    return _remove_preference_response(service, "watchlist_items", session_id, show_id)


@router.delete("/watchlist-items/{show_id}/{session_id}", response_model=PreferenceResponse)
def remove_watchlist_item_by_path(
    show_id: str,
    session_id: UUID,
    service: InteractionService = Depends(get_interaction_service),
) -> PreferenceResponse:
    """Path-based watchlist removal for hosts that filter session query keys."""

    return _remove_preference_response(service, "watchlist_items", session_id, show_id)


@router.get("/state", response_model=InteractionStateResponse)
def get_interaction_state(
    session_id: UUID = Query(...),
    service: InteractionService = Depends(get_interaction_service),
) -> InteractionStateResponse:
    """Restore latest ratings and active preference state for a session."""

    try:
        return InteractionStateResponse(**service.get_state(session_id))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/state/{session_id}", response_model=InteractionStateResponse)
def get_interaction_state_by_path(
    session_id: UUID,
    service: InteractionService = Depends(get_interaction_service),
) -> InteractionStateResponse:
    """Path-based state restore for hosts that filter session query keys."""

    try:
        return InteractionStateResponse(**service.get_state(session_id))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


def _preference_response(
    service: InteractionService,
    table_name: str,
    payload: PreferenceCreateRequest,
) -> PreferenceResponse:
    try:
        return PreferenceResponse(**service.add_preference(table_name, payload.session_id, payload.show_id))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _remove_preference_response(
    service: InteractionService,
    table_name: str,
    session_id: UUID,
    show_id: str,
) -> PreferenceResponse:
    try:
        return PreferenceResponse(**service.remove_preference(table_name, session_id, show_id))
    except InteractionNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InteractionValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
