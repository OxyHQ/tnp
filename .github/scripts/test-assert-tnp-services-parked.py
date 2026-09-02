#!/usr/bin/env python3
"""Mutation controls for the fail-closed TNP ECS parking gate."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("assert-tnp-services-parked.py")
WORKFLOW = SCRIPT.parent.parent / "workflows" / "deploy-aws.yml"
SERVICES = ("tnp-api", "tnp-dns")
COUNT_FIELDS = ("desiredCount", "runningCount", "pendingCount")


def parked_payload() -> dict[str, object]:
    return {
        "services": [
            {
                "serviceName": name,
                "desiredCount": 0,
                "runningCount": 0,
                "pendingCount": 0,
            }
            for name in SERVICES
        ],
        "failures": [],
    }


def run_gate(payload: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )


class ParkingGateTest(unittest.TestCase):
    def test_workflow_queries_only_the_two_images_it_publishes(self) -> None:
        workflow = WORKFLOW.read_text()
        self.assertIn("--services tnp-api tnp-dns --output json", workflow)
        self.assertNotIn("--services tnp-api tnp-dns tnp-relay", workflow)

    def test_exact_zero_state_passes(self) -> None:
        result = run_gate(parked_payload())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_nonzero_count_fails_closed(self) -> None:
        for service_index, service_name in enumerate(SERVICES):
            for field in COUNT_FIELDS:
                with self.subTest(service=service_name, field=field):
                    payload = copy.deepcopy(parked_payload())
                    payload["services"][service_index][field] = 1  # type: ignore[index]
                    result = run_gate(payload)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(service_name, result.stderr)
                    self.assertIn(field, result.stderr)

    def test_each_missing_count_fails_closed(self) -> None:
        for field in COUNT_FIELDS:
            with self.subTest(field=field):
                payload = copy.deepcopy(parked_payload())
                del payload["services"][0][field]  # type: ignore[index]
                result = run_gate(payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(field, result.stderr)

    def test_missing_or_extra_service_fails_closed(self) -> None:
        missing = parked_payload()
        missing["services"] = missing["services"][:-1]  # type: ignore[index]
        self.assertNotEqual(run_gate(missing).returncode, 0)

        extra = parked_payload()
        extra["services"].append(  # type: ignore[union-attr]
            {
                "serviceName": "tnp-other",
                "desiredCount": 0,
                "runningCount": 0,
                "pendingCount": 0,
            }
        )
        self.assertNotEqual(run_gate(extra).returncode, 0)

    def test_aws_lookup_failure_fails_closed(self) -> None:
        payload = parked_payload()
        payload["failures"] = [{"arn": "tnp-dns", "reason": "MISSING"}]
        self.assertNotEqual(run_gate(payload).returncode, 0)


if __name__ == "__main__":
    unittest.main()
