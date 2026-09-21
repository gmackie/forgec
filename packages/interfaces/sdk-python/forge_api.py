"""Generic Forge API client (FORGE-055, PAR-123).

One class for every Forge deployment. Operations are discovered from the
deployment's own OpenAPI projection; the unary envelope is the same one the
TypeScript and Go clients use:

    client = Client("https://api.example", token="...")
    rec = client.call("Customer.create", {"code": "ACME", "name": "Acme"})
    page = client.call("Customer.list.byTier", {"params": {"tier": "gold"}, "limit": 20})

Money and decimal fields travel as strings and are decoded to ``decimal.Decimal``
(never float). ``None`` in a PATCH clears the field; an absent key leaves it
alone. A Problem the contract declares raises ``ProblemError``; a failure to
perform the call at all raises ``InvocationFailed``. Standard library only.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Mapping, Optional

__all__ = ["Client", "ProblemError", "InvocationFailed", "canonical"]


class ProblemError(Exception):
    """A business outcome: the Problem Details document the server returned."""

    def __init__(self, problem: Mapping[str, Any]):
        super().__init__(f"{problem.get('code')}: {problem.get('detail') or problem.get('title') or ''}")
        self.problem = dict(problem)
        self.code: str = str(problem.get("code"))
        self.status: int = int(problem.get("status", 0))
        self.detail: Optional[str] = problem.get("detail")
        self.fields: list = list(problem.get("fields") or [])
        self.retryable: bool = bool(problem.get("retryable", False))


class InvocationFailed(Exception):
    """The binding could not perform the call: transport, malformed reply, contract mismatch, credential."""

    def __init__(self, reason: str, detail: str, retryable: bool = False):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail
        self.retryable = retryable


def _decode(text: str) -> Any:
    # Numbers with a fraction are decimals on the wire only where the schema says so; JSON numbers
    # in Forge contracts are integers, and money/decimal are strings. Parse floats as Decimal anyway
    # so no client ever rounds a value the server did not.
    return json.loads(text, parse_float=Decimal) if text else None


class _Encoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:  # noqa: D401
        if isinstance(o, Decimal):
            return format(o, "f")
        return super().default(o)


def canonical(value: Any) -> str:
    """Canonical JSON: sorted keys, no whitespace, decimals as plain strings."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), cls=_Encoder)


@dataclass
class _Route:
    method: str
    path: str
    kind: str
    path_params: list = field(default_factory=list)


class Client:
    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        dev: Optional[tuple] = None,
        purpose: Optional[str] = None,
        expect: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base = base_url.rstrip("/")
        if token:
            self._auth = {"Authorization": f"Bearer {token}"}
        elif dev:
            self._auth = {"X-Forge-Tenant": dev[0], "X-Forge-Actor": dev[1]}
        else:
            raise ValueError("a bearer token or a development (tenant, actor) pair is required")
        self.purpose = purpose
        self.expect = dict(expect or {})
        self.timeout = timeout
        self._routes: Optional[dict] = None
        self.discovery: Optional[dict] = None

    # ------------------------------------------------------------ discovery
    def _http(self, method: str, path: str, body: Any = None, headers: Optional[Mapping[str, str]] = None):
        data = None
        h = {**self._auth, "Accept": "application/json", **(headers or {})}
        if body is not None:
            data = canonical(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.status, dict(res.headers), res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode("utf-8")
        except (urllib.error.URLError, OSError) as e:
            raise InvocationFailed("transport", str(e.reason if hasattr(e, "reason") else e), retryable=True) from None

    def _load(self) -> dict:
        if self._routes is not None:
            return self._routes
        status, _, text = self._http("GET", "/forge/discovery")
        if status in (401, 403):
            raise InvocationFailed("unauthenticated", "the credential is not accepted by this deployment")
        if status != 200:
            raise InvocationFailed("malformed", f"discovery answered {status}", retryable=status >= 500)
        self.discovery = json.loads(text)
        mismatches = []
        if "contracts" in self.expect and (self.discovery.get("contracts") or {}).get("version") != self.expect["contracts"]:
            mismatches.append("contracts")
        if "wire" in self.expect and (self.discovery.get("digests") or {}).get("wire") != self.expect["wire"]:
            mismatches.append("wire digest")
        if mismatches:
            # A compatibility question for `forgec compat`, never assumed equivalence.
            raise InvocationFailed("contract-mismatch", ", ".join(mismatches) + " differ from the expectation")
        status, _, text = self._http("GET", "/forge/openapi.json")
        if status != 200:
            raise InvocationFailed("malformed", f"openapi answered {status}")
        doc = json.loads(text)
        routes: dict = {}
        for path, ops in doc["paths"].items():
            for method, op in ops.items():
                params = [seg[1:-1] for seg in path.split("/") if seg.startswith("{")]
                routes[op["operationId"]] = _Route(method.upper(), path, op.get("x-forge-kind", "function"), params)
        self._routes = routes
        return routes

    def operations(self) -> list:
        return sorted(self._load().keys())

    def _resolve(self, operation: str) -> tuple:
        routes = self._load()
        if operation in routes:
            return operation, routes[operation]
        for op_id, r in routes.items():
            if op_id.rsplit("/_/", 1)[-1] == operation:
                return op_id, r
        raise ProblemError({"code": "MethodNotAllowed", "status": 405, "detail": f"unknown operation {operation}"})

    # ------------------------------------------------------------- envelope
    @staticmethod
    def _request(route: _Route, inp: Mapping[str, Any]) -> tuple:
        """Mirror of the TypeScript `toHttpRequest`: envelope -> (path, body, headers)."""
        headers: dict = {}
        path = route.path
        query: dict = {}
        body: Any = None
        inp = dict(inp)

        def fill(params: Mapping[str, Any]) -> None:
            nonlocal path
            for p in route.path_params:
                path = path.replace("{" + p + "}", urllib.parse.quote(str(params.get(p, "")), safe=""))

        def if_match() -> None:
            if inp.get("expectedVersion") is not None:
                headers["If-Match"] = f'"{inp["expectedVersion"]}"'

        k = route.kind
        if k in ("create", "changeset.propose", "workflow.start", "schedule.tick"):
            body = {kk: v for kk, v in inp.items() if kk not in route.path_params} if k == "workflow.start" else inp
            fill(inp)
        elif k == "update":
            fill(inp); if_match(); body = inp.get("patch", {})
        elif k == "transition":
            fill(inp); if_match(); body = inp.get("input", {})
        elif k in ("delete", "restore", "finalizeUpload"):
            fill(inp); if_match()
        elif k in ("move", "beginUpload"):
            fill(inp); if_match()
            body = {kk: v for kk, v in inp.items() if kk not in ("id", "expectedVersion")}
        elif k in ("find", "list", "view.query", "effective"):
            for kk, v in (inp.get("params") or {}).items():
                query[kk] = str(v)
            if inp.get("cursor"):
                query["cursor"] = str(inp["cursor"])
            if inp.get("limit"):
                query["limit"] = str(inp["limit"])
        elif k == "cache.read":
            for kk, v in (inp.get("key") or {}).items():
                query[kk] = str(v)
        elif k == "function":
            fill(inp); if_match()
            body = {kk: v for kk, v in inp.items() if kk not in route.path_params}
        else:
            fill(inp)
            if route.method != "GET":
                body = {kk: v for kk, v in inp.items() if kk not in route.path_params and kk != "id"}
        if query:
            path += "?" + urllib.parse.urlencode(query)
        return path, body, headers

    def call(self, operation: str, inp: Optional[Mapping[str, Any]] = None, *, purpose: Optional[str] = None, idempotency_key: Optional[str] = None) -> Any:
        op_id, route = self._resolve(operation)
        path, body, headers = self._request(route, inp or {})
        p = purpose or self.purpose
        if p:
            headers["X-Forge-Purpose"] = p
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        status, res_headers, text = self._http(route.method, path, body, headers)
        try:
            payload = _decode(text)
        except ValueError:
            raise InvocationFailed("malformed", f"non-JSON reply ({status})", retryable=status >= 500) from None
        if 200 <= status < 300:
            return payload
        if status == 401:
            raise InvocationFailed("unauthenticated", "the credential is not accepted by this deployment")
        if isinstance(payload, dict) and isinstance(payload.get("code"), str):
            raise ProblemError(payload)
        raise InvocationFailed("malformed", f"reply {status} is not a Problem", retryable=status >= 500)
