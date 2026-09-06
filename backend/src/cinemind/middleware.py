"""ASGI middleware used to bound untrusted HTTP request bodies."""

from collections.abc import Callable

from starlette.responses import JSONResponse


class _RequestBodyTooLarge(Exception):
    """Internal signal raised when a streamed body exceeds the configured cap."""


class RequestBodyLimitMiddleware:
    """Reject oversized bodies before route handlers parse or persist them."""

    def __init__(self, app, max_body_bytes: int):
        if max_body_bytes < 1:
            raise ValueError("max_body_bytes must be positive")
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_bytes:
            await self._respond_too_large(scope, receive, send)
            return

        received_bytes = 0

        async def limited_receive():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_body_bytes:
                    raise _RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _RequestBodyTooLarge:
            await self._respond_too_large(scope, receive, send)

    @staticmethod
    def _content_length(scope) -> int | None:
        headers = {
            key.decode("latin-1").casefold(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        raw_length = headers.get("content-length")
        if raw_length is None:
            return None
        try:
            value = int(raw_length)
        except ValueError:
            return None
        return value if value >= 0 else None

    @staticmethod
    async def _respond_too_large(scope, receive, send) -> None:
        response = JSONResponse(
            {"detail": "Request body is too large"},
            status_code=413,
        )
        await response(scope, receive, send)
