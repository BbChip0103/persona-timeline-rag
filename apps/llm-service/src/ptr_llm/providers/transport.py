"""Bound actual SDK HTTP response allocation before httpx/OpenAI JSON parsing."""

from collections.abc import AsyncIterator
from ssl import SSLContext

import httpx

from ptr_llm.billing import ProviderError

RESPONSE_LIMIT = 2 * 1024 * 1024


class LimitedStream(httpx.AsyncByteStream):
    def __init__(self, stream: httpx.AsyncByteStream):
        self.stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        total = 0
        try:
            async for chunk in self.stream:
                total += len(chunk)
                if total > RESPONSE_LIMIT:
                    raise ProviderError("PROVIDER_RESPONSE_LIMIT")
                yield chunk
        finally:
            await self.stream.aclose()

    async def aclose(self) -> None:
        await self.stream.aclose()


class LimitedTransport(httpx.AsyncBaseTransport):
    def __init__(
        self, inner: httpx.AsyncBaseTransport | None = None, ssl_context: SSLContext | None = None
    ):
        self.inner = (
            inner
            if inner is not None
            else httpx.AsyncHTTPTransport(
                verify=ssl_context if ssl_context is not None else True, retries=0
            )
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # A wire-byte cap cannot bound decompressor allocation. Require identity even
        # when an upstream ignores our negotiation, before httpx reads any body.
        request.headers["Accept-Encoding"] = "identity"
        response = await self.inner.handle_async_request(request)
        if response.headers.get("content-encoding", "identity").strip().lower() != "identity":
            await response.aclose()
            raise ProviderError("PROVIDER_RESPONSE_ENCODING")
        if not isinstance(response.stream, httpx.AsyncByteStream):
            await response.aclose()
            raise ProviderError("PROVIDER_TRANSPORT")
        response.stream = LimitedStream(response.stream)
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()
