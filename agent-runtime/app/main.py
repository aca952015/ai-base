from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from importlib.metadata import version
from uuid import uuid4

import psycopg
from fastapi import FastAPI, HTTPException
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic import BaseModel

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ai_base:ai-base-local-only@localhost:5432/ai_base",
)

REGISTERED_AGENTS = {
    "it-service-desk": {
        "name": "IT 服务台",
        "modelAlias": "general-fast",
        "tools": ["knowledge.search", "open-connector.actions"],
    }
}


def configure_tracing() -> None:
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    if not endpoint:
        return

    provider = TracerProvider(
        resource=Resource.create(
            {"service.name": os.environ.get("OTEL_SERVICE_NAME", "ai-base-agent-runtime")}
        )
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)


def initialize_database() -> None:
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS runtime_events (
                    id uuid PRIMARY KEY,
                    event_type text NOT NULL,
                    agent_id text NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
        connection.commit()


def database_snapshot() -> dict[str, object]:
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            extension = cursor.fetchone()
            cursor.execute("SELECT count(*) FROM runtime_events")
            events = cursor.fetchone()
            cursor.execute("SELECT pg_database_size(current_database())")
            database_size = cursor.fetchone()
            cursor.execute(
                "SELECT event_type, count(*) FROM runtime_events GROUP BY event_type ORDER BY event_type"
            )
            event_types = cursor.fetchall()
    return {
        "database": "ready",
        "pgvector": extension[0] if extension else "missing",
        "runtimeEvents": int(events[0]) if events else 0,
        "databaseSizeBytes": int(database_size[0]) if database_size else 0,
        "runtimeEventTypes": {
            event_type: int(count) for event_type, count in event_types
        },
    }


def runtime_events_snapshot(limit: int = 50) -> list[dict[str, str]]:
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, event_type, agent_id, created_at
                FROM runtime_events
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (limit,),
            )
            rows = cursor.fetchall()
    return [
        {
            "id": str(event_id),
            "eventType": event_type,
            "agentId": agent_id,
            "createdAt": created_at.isoformat(),
        }
        for event_id, event_type, agent_id, created_at in rows
    ]


def agents_snapshot() -> list[dict[str, object]]:
    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT agent_id, count(*), max(created_at)
                FROM runtime_events
                GROUP BY agent_id
                """
            )
            rows = cursor.fetchall()

    activity = {
        agent_id: {
            "runCount": int(run_count),
            "latestRunAt": latest_run_at.isoformat() if latest_run_at else None,
        }
        for agent_id, run_count, latest_run_at in rows
    }
    agent_ids = list(dict.fromkeys([*REGISTERED_AGENTS.keys(), *activity.keys()]))
    items: list[dict[str, object]] = []
    for agent_id in agent_ids:
        registered = REGISTERED_AGENTS.get(agent_id)
        observed = activity.get(agent_id, {"runCount": 0, "latestRunAt": None})
        items.append(
            {
                "id": agent_id,
                "name": registered["name"] if registered else agent_id,
                "status": "ready" if registered else "observed",
                "modelAlias": registered["modelAlias"] if registered else None,
                "tools": registered["tools"] if registered else [],
                **observed,
            }
        )
    return items


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_tracing()
    await asyncio.to_thread(initialize_database)
    yield


app = FastAPI(
    title="AI Base Agent Runtime",
    version="0.1.0",
    description="Lightweight control boundary for PydanticAI agents and OpenConnector actions.",
    lifespan=lifespan,
)
FastAPIInstrumentor.instrument_app(app)


class DemoRunRequest(BaseModel):
    agent_id: str = "it-service-desk"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-base-agent-runtime"}


@app.get("/ready")
async def ready() -> dict[str, object]:
    try:
        return await asyncio.to_thread(database_snapshot)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="database unavailable") from error


@app.get("/v1/stack")
def stack() -> dict[str, object]:
    return {
        "runtime": {
            "fastapi": version("fastapi"),
            "pydanticAi": version("pydantic-ai-slim"),
            "mcp": version("mcp"),
            "dbos": version("dbos"),
        },
        "services": {
            "modelGateway": os.environ.get("LLM_GATEWAY_URL", "not-configured"),
            "externalConnector": os.environ.get("OPEN_CONNECTOR_URL", "not-configured"),
            "tracing": os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "not-configured"),
        },
        "securityBoundary": "Agent Runtime owns identity, approvals and audit; OpenConnector owns SaaS credentials.",
    }


@app.get("/v1/agents")
async def agents() -> dict[str, object]:
    try:
        return {"items": await asyncio.to_thread(agents_snapshot)}
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="could not read agents") from error


@app.get("/v1/runtime-events")
async def runtime_events() -> dict[str, object]:
    try:
        items = await asyncio.to_thread(runtime_events_snapshot)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="could not read runtime events") from error
    return {"items": items, "total": len(items)}


@app.post("/v1/demo-runs", status_code=201)
async def create_demo_run(request: DemoRunRequest) -> dict[str, str]:
    run_id = uuid4()
    tracer = trace.get_tracer("ai-base.demo")

    def write_event() -> None:
        with tracer.start_as_current_span(
            "agent.demo-run",
            attributes={"agent.id": request.agent_id, "run.id": str(run_id)},
        ):
            with psycopg.connect(DATABASE_URL) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "INSERT INTO runtime_events (id, event_type, agent_id) VALUES (%s, %s, %s)",
                        (run_id, "demo-run", request.agent_id),
                    )
                connection.commit()

    try:
        await asyncio.to_thread(write_event)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="could not record demo run") from error

    return {
        "id": str(run_id),
        "agentId": request.agent_id,
        "status": "recorded",
        "createdAt": datetime.now(UTC).isoformat(),
    }
