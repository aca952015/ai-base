from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from opentelemetry.sdk.trace import TracerProvider

from app.main import (
    DemoRunRequest,
    RUNTIME_EVENT_MIGRATIONS,
    create_demo_run,
    migrate_runtime_events,
)


class RecordingCursor:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement: str) -> None:
        self.statements.append(statement)


class EventCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def __enter__(self) -> EventCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(
        self, statement: str, parameters: tuple[object, ...] | None = None
    ) -> None:
        self.executed.append((statement, parameters))


class EventConnection:
    def __init__(self, cursor: EventCursor) -> None:
        self._cursor = cursor
        self.committed = False

    def __enter__(self) -> EventConnection:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def cursor(self) -> EventCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed = True


class RuntimeEventMigrationTests(unittest.TestCase):
    def test_demo_event_persists_the_active_trace_span_and_run_ids(self) -> None:
        provider = TracerProvider()
        tracer = provider.get_tracer("runtime-event-test")
        cursor = EventCursor()
        connection = EventConnection(cursor)

        with (
            patch("app.main.trace.get_tracer", return_value=tracer),
            patch("app.main.psycopg.connect", return_value=connection),
        ):
            response = asyncio.run(create_demo_run(DemoRunRequest()))

        self.assertTrue(connection.committed)
        self.assertEqual(len(cursor.executed), 1)
        _, parameters = cursor.executed[0]
        self.assertIsNotNone(parameters)
        assert parameters is not None
        self.assertEqual(parameters[3], response["traceId"])
        self.assertEqual(parameters[4], response["spanId"])
        self.assertEqual(str(parameters[5]), response["runId"])
        self.assertEqual(len(response["traceId"] or ""), 32)
        self.assertEqual(len(response["spanId"] or ""), 16)
        provider.shutdown()

    def test_runtime_event_migration_is_repeatable(self) -> None:
        cursor = RecordingCursor()
        migrate_runtime_events(cursor)
        migrate_runtime_events(cursor)

        expected = [*RUNTIME_EVENT_MIGRATIONS, *RUNTIME_EVENT_MIGRATIONS]
        self.assertEqual(cursor.statements, expected)
        self.assertTrue(
            all("ADD COLUMN IF NOT EXISTS" in statement for statement in expected)
        )


if __name__ == "__main__":
    unittest.main()
