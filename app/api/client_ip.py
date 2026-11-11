"""The client address, honouring TRUST_PROXY_HOPS (what proxy-addr does with a hop count).

With N trusted hops the nearest N proxies' `X-Forwarded-For` entries are believed: the client is the address the
outermost trusted proxy saw. Too few hops makes every client share the proxy's IP; too many lets clients spoof it.
"""

from __future__ import annotations

from collections.abc import Callable

from starlette.requests import HTTPConnection

ClientIp = Callable[[HTTPConnection], str]


def make_client_ip(trust_proxy_hops: int = 0) -> ClientIp:
    def client_ip(request: HTTPConnection) -> str:
        peer = request.client.host if request.client else "unknown"
        if trust_proxy_hops <= 0:
            return peer
        forwarded = [
            part.strip() for header in request.headers.getlist("x-forwarded-for") for part in header.split(",")
        ]
        chain = [peer, *reversed([part for part in forwarded if part])]
        return chain[min(trust_proxy_hops, len(chain) - 1)]

    return client_ip


#: The socket address (no trusted proxy).
peer_ip: ClientIp = make_client_ip(0)
