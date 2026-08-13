from __future__ import annotations

import logging
import os
from collections.abc import Iterator, Mapping, MutableMapping, Sequence
from contextlib import contextmanager
from typing import Any, Literal

from opentelemetry import trace
from opentelemetry.propagate import set_global_textmap
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExportResult,
    SpanExporter,
)
from opentelemetry.sdk.trace.sampling import ALWAYS_ON
from opentelemetry.trace import (
    Link,
    Span,
    SpanContext,
    SpanKind,
    Status,
    StatusCode,
    Tracer,
    use_span,
)
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import AttributeValue, Attributes
from pydantic_ai import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings

logger = logging.getLogger(__name__)

CallKind = Literal["model", "mcp"]
TRAFFIC_ORIGIN_HEADER = "X-AI-Base-Traffic-Origin"

# PydanticAI 2.12.0 does not expose an include_model_request_parameters switch.
# These attributes can contain prompts, tool schemas, arguments, results, or arbitrary
# application metadata, so the PydanticAI-specific tracer removes them before the SDK
# span is created or updated.
_CONTENT_ATTRIBUTE_KEYS = frozenset(
    {
        "final_result",
        "exception.message",
        "exception.stacktrace",
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "gen_ai.tool.definitions",
        "logfire.json_schema",
        "metadata",
        "model_request_parameters",
        "otel.status_description",
        "pydantic_ai.all_messages",
    }
)


def _safe_attributes(attributes: Attributes) -> dict[str, AttributeValue] | None:
    if not attributes:
        return None
    return {
        key: value
        for key, value in attributes.items()
        if key not in _CONTENT_ATTRIBUTE_KEYS
    }


class ContentSafeSpan(Span):
    """Span facade that prevents sensitive PydanticAI content from being recorded."""

    def __init__(self, span: Span) -> None:
        self._span = span

    def get_span_context(self) -> SpanContext:
        return self._span.get_span_context()

    def is_recording(self) -> bool:
        return self._span.is_recording()

    def set_attribute(self, key: str, value: AttributeValue) -> None:
        if key not in _CONTENT_ATTRIBUTE_KEYS:
            self._span.set_attribute(key, value)

    def set_attributes(self, attributes: Mapping[str, AttributeValue]) -> None:
        if safe := _safe_attributes(attributes):
            self._span.set_attributes(safe)

    def add_event(
        self,
        name: str,
        attributes: Attributes = None,
        timestamp: int | None = None,
    ) -> None:
        self._span.add_event(name, _safe_attributes(attributes), timestamp)

    def set_status(
        self,
        status: Status | StatusCode,
        description: str | None = None,
    ) -> None:
        # Error descriptions can contain provider response bodies. The status code is
        # sufficient for the safe diagnostics view; error type is recorded separately.
        safe_status = Status(status.status_code) if isinstance(status, Status) else status
        self._span.set_status(safe_status, None)

    def update_name(self, name: str) -> None:
        self._span.update_name(name)

    def end(self, end_time: int | None = None) -> None:
        self._span.end(end_time)

    def record_exception(
        self,
        exception: BaseException,
        attributes: Attributes = None,
        timestamp: int | None = None,
        escaped: bool = False,
    ) -> None:
        # Exception messages and stack traces may embed prompts or provider bodies.
        safe = _safe_attributes(attributes) or {}
        safe["exception.type"] = f"{type(exception).__module__}.{type(exception).__qualname__}"
        safe["exception.escaped"] = escaped
        self._span.add_event("exception", safe, timestamp)


class ContentSafeTracer(Tracer):
    """Tracer facade used only by PydanticAI instrumentation."""

    def __init__(self, tracer: Tracer) -> None:
        self._tracer = tracer

    def start_span(
        self,
        name: str,
        context: Any = None,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        start_time: int | None = None,
        record_exception: bool = True,
        set_status_on_exception: bool = True,
    ) -> Span:
        span = self._tracer.start_span(
            name,
            context=context,
            kind=kind,
            attributes=_safe_attributes(attributes),
            links=links,
            start_time=start_time,
            record_exception=record_exception,
            set_status_on_exception=set_status_on_exception,
        )
        return ContentSafeSpan(span)

    @contextmanager
    def start_as_current_span(
        self,
        name: str,
        context: Any = None,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        start_time: int | None = None,
        record_exception: bool = True,
        set_status_on_exception: bool = True,
        end_on_exit: bool = True,
    ) -> Iterator[Span]:
        span = self.start_span(
            name,
            context=context,
            kind=kind,
            attributes=attributes,
            links=links,
            start_time=start_time,
            record_exception=record_exception,
            set_status_on_exception=set_status_on_exception,
        )
        with use_span(
            span,
            end_on_exit=end_on_exit,
            record_exception=record_exception,
            set_status_on_exception=set_status_on_exception,
        ) as current:
            yield current


class FailOpenSpanExporter(SpanExporter):
    """Keep exporter failures on the telemetry path, never the request path."""

    def __init__(self, exporter: SpanExporter) -> None:
        self._exporter = exporter

    def export(self, spans: Sequence[Any]) -> SpanExportResult:
        try:
            return self._exporter.export(spans)
        except Exception as error:  # pragma: no cover - exercised with a fake exporter
            logger.warning("trace export failed", extra={"error_type": type(error).__name__})
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        try:
            self._exporter.shutdown()
        except Exception as error:  # pragma: no cover - defensive SDK boundary
            logger.warning("trace exporter shutdown failed", extra={"error_type": type(error).__name__})

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        try:
            return self._exporter.force_flush(timeout_millis)
        except Exception as error:  # pragma: no cover - defensive SDK boundary
            logger.warning("trace exporter flush failed", extra={"error_type": type(error).__name__})
            return False


def pydantic_ai_instrumentation(
    provider: TracerProvider | None = None,
) -> InstrumentationSettings:
    """Return the single safe PydanticAI telemetry policy for this runtime."""

    settings = InstrumentationSettings(
        tracer_provider=provider,
        include_binary_content=False,
        include_content=False,
        version=5,
        use_aggregated_usage_attribute_names=True,
    )
    settings.tracer = ContentSafeTracer(settings.tracer)
    return settings


def configure_observability() -> TracerProvider | None:
    """Configure 100% W3C tracing and safe PydanticAI instrumentation.

    A missing or invalid exporter degrades to no export. PydanticAI content safety is
    still installed so future Agent instances cannot silently enable content capture.
    """

    set_global_textmap(CompositePropagator([TraceContextTextMapPropagator()]))
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    provider: TracerProvider | None = None

    if endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            provider = TracerProvider(
                sampler=ALWAYS_ON,
                resource=Resource.create(
                    {
                        "service.name": os.environ.get(
                            "OTEL_SERVICE_NAME", "ai-base-agent-runtime"
                        )
                    }
                ),
            )
            provider.add_span_processor(
                BatchSpanProcessor(FailOpenSpanExporter(OTLPSpanExporter(endpoint=endpoint)))
            )
            trace.set_tracer_provider(provider)
        except Exception as error:
            provider = None
            logger.warning(
                "trace exporter configuration failed",
                extra={"error_type": type(error).__name__},
            )

    Agent.instrument_all(pydantic_ai_instrumentation(provider))
    return provider


def shutdown_observability(provider: TracerProvider | None) -> None:
    if provider is not None:
        provider.shutdown()


def current_trace_ids() -> tuple[str | None, str | None]:
    context = trace.get_current_span().get_span_context()
    if not context.is_valid:
        return None, None
    return f"{context.trace_id:032x}", f"{context.span_id:016x}"


def inject_current_trace_context(
    carrier: MutableMapping[str, str], *, kind: CallKind = "model"
) -> None:
    """Inject trusted W3C TraceContext and a call-bound internal origin."""

    TraceContextTextMapPropagator().inject(carrier)
    carrier[TRAFFIC_ORIGIN_HEADER] = (
        "internal_envoy" if kind == "mcp" else "internal_service"
    )


@contextmanager
def runtime_client_span(
    kind: CallKind,
    target_alias: str,
    *,
    agent_id: str | None = None,
    run_id: str | None = None,
) -> Iterator[Span]:
    """Reusable correlation boundary for future real model and MCP clients."""

    attributes: dict[str, AttributeValue] = {
        "ai_base.call.kind": kind,
        "ai_base.call.target": target_alias,
        "traffic.origin": "internal_envoy" if kind == "mcp" else "internal_service",
    }
    if agent_id:
        attributes["agent.id"] = agent_id
    if run_id:
        attributes["run.id"] = run_id
    with trace.get_tracer("ai-base.agent-runtime").start_as_current_span(
        f"{kind}.client.call",
        kind=SpanKind.CLIENT,
        attributes=attributes,
    ) as span:
        yield span
