#!/usr/bin/env python3
"""Fail closed unless the exact API and DNS services have no live work."""

from __future__ import annotations

import json
import sys
from typing import Any


EXPECTED_SERVICES = {"tnp-api", "tnp-dns"}
COUNT_FIELDS = ("desiredCount", "runningCount", "pendingCount")


def validate(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return "ECS describe-services returned a non-object payload"

    failures = payload.get("failures")
    if not isinstance(failures, list) or failures:
        return "ECS did not resolve the exact TNP API and DNS services without failures"

    raw_services = payload.get("services")
    if not isinstance(raw_services, list):
        return "ECS describe-services omitted the services list"

    services: dict[str, dict[str, Any]] = {}
    for service in raw_services:
        if not isinstance(service, dict) or not isinstance(service.get("serviceName"), str):
            return "ECS returned a service without a valid serviceName"
        name = service["serviceName"]
        if name in services:
            return f"ECS returned duplicate service {name}"
        services[name] = service

    if set(services) != EXPECTED_SERVICES:
        return (
            "ECS service set mismatch: "
            f"expected {sorted(EXPECTED_SERVICES)}, got {sorted(services)}"
        )

    unsafe: dict[str, dict[str, Any]] = {}
    for name, service in services.items():
        counts: dict[str, Any] = {}
        for field in COUNT_FIELDS:
            value = service.get(field)
            if type(value) is not int or value != 0:
                counts[field] = value
        if counts:
            unsafe[name] = counts

    if unsafe:
        return (
            "TNP image publication requires desiredCount, runningCount, and "
            f"pendingCount all equal to zero: {unsafe}"
        )

    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"::error::invalid ECS describe-services JSON: {error}", file=sys.stderr)
        return 1

    error = validate(payload)
    if error:
        print(f"::error::{error}", file=sys.stderr)
        return 1

    print(
        "tnp-api and tnp-dns both have "
        "desiredCount=0, runningCount=0, and pendingCount=0"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
