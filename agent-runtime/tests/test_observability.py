from __future__ import annotations

import unittest
from unittest.mock import patch

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExportResult,
    SpanExporter,
)
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from app.observability import (
    FailOpenSpanExporter,
    configure_observability,
    current_trace_ids,
    inject_current_trace_context,
    pydantic_ai_instrumentation,
    runtime_client_span,
)

SENTINEL = "sentinel-prompt-output-tool-secret-4f53a91c"


class ExplodingExporter(SpanExporter):
    def export(self, spans: object) -> SpanExportResult:
        raise RuntimeError(SENTINEL)

    def shutdown(self) -> None:
        raise RuntimeError(SENTINEL)

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        raise RuntimeError(SENTINEL)


class ObservabilityTests(unittest.TestCase):
    def test_model_and_mcp_client_boundaries_preserve_run_correlation(self) -> None:
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        tracer = provider.get_tracer("correlation-test")

        with (
            patch("app.observability.trace.get_tracer", return_value=tracer),
            tracer.start_as_current_span("agent-run"),
        ):
            parent_trace_id, _ = current_trace_ids()
            with runtime_client_span(
                "model", "general-fast", agent_id="agent-1", run_id="run-1"
            ):
                model_trace_id, _ = current_trace_ids()
            with runtime_client_span(
                "mcp", "open-connector", agent_id="agent-1", run_id="run-1"
            ):
                mcp_trace_id, _ = current_trace_ids()

        self.assertEqual(parent_trace_id, model_trace_id)
        self.assertEqual(parent_trace_id, mcp_trace_id)
        client_spans = {
            span.attributes["ai_base.call.kind"]: span
            for span in exporter.get_finished_spans()
            if "ai_base.call.kind" in (span.attributes or {})
        }
        self.assertEqual(set(client_spans), {"model", "mcp"})
        for span in client_spans.values():
            self.assertEqual(span.attributes["agent.id"], "agent-1")
            self.assertEqual(span.attributes["run.id"], "run-1")
        self.assertEqual(
            client_spans["model"].attributes["traffic.origin"], "internal_service"
        )
        self.assertEqual(
            client_spans["mcp"].attributes["traffic.origin"], "internal_envoy"
        )
        provider.shutdown()

    def test_pydantic_ai_spans_never_record_content_or_request_parameters(self) -> None:
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        settings = pydantic_ai_instrumentation(provider)
        Agent.instrument_all(settings)

        def secret_tool(secret_argument: str) -> str:
            return f"tool-result-{secret_argument}-{SENTINEL}"

        agent = Agent(
            TestModel(call_tools=["secret_tool"], custom_output_text=SENTINEL),
            name="safe-test-agent",
            instructions=f"system-{SENTINEL}",
            metadata={"unsafe": SENTINEL},
            tools=[secret_tool],
        )
        result = agent.run_sync(f"user-{SENTINEL}")
        self.assertEqual(result.output, SENTINEL)

        spans = exporter.get_finished_spans()
        self.assertGreaterEqual(len(spans), 3)
        serialized = repr(
            [
                (
                    span.name,
                    dict(span.attributes or {}),
                    [(event.name, dict(event.attributes or {})) for event in span.events],
                    span.status.description,
                )
                for span in spans
            ]
        )
        self.assertNotIn(SENTINEL, serialized)
        forbidden = {
            "final_result",
            "exception.message",
            "exception.stacktrace",
            "gen_ai.input.messages",
            "gen_ai.output.messages",
            "gen_ai.system_instructions",
            "gen_ai.tool.call.arguments",
            "gen_ai.tool.call.result",
            "gen_ai.tool.definitions",
            "metadata",
            "model_request_parameters",
            "otel.status_description",
            "pydantic_ai.all_messages",
        }
        observed_keys = {
            key for span in spans for key in (span.attributes or {}).keys()
        }
        self.assertTrue(forbidden.isdisjoint(observed_keys))
        self.assertIn("gen_ai.request.model", observed_keys)
        self.assertFalse(settings.include_content)
        self.assertFalse(settings.include_binary_content)
        self.assertEqual(settings.version, 5)
        provider.shutdown()

    def test_current_trace_ids_and_w3c_carrier_share_the_active_trace(self) -> None:
        provider = TracerProvider()
        with provider.get_tracer("test").start_as_current_span("agent-run"):
            trace_id, span_id = current_trace_ids()
            carrier: dict[str, str] = {}
            inject_current_trace_context(carrier)

            mcp_carrier: dict[str, str] = {}
            inject_current_trace_context(mcp_carrier, kind="mcp")

        self.assertIsNotNone(trace_id)
        self.assertIsNotNone(span_id)
        self.assertEqual(len(trace_id or ""), 32)
        self.assertEqual(len(span_id or ""), 16)
        self.assertIn("traceparent", carrier)
        self.assertIn(trace_id or "missing", carrier["traceparent"])
        self.assertEqual(carrier["X-AI-Base-Traffic-Origin"], "internal_service")

        self.assertIn(trace_id or "missing", mcp_carrier["traceparent"])
        self.assertEqual(mcp_carrier["X-AI-Base-Traffic-Origin"], "internal_envoy")
        self.assertNotIn("baggage", carrier)
        provider.shutdown()

    def test_missing_exporter_is_a_noop_and_does_not_break_agent_runs(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            provider = configure_observability()
        self.assertIsNone(provider)

        agent = Agent(TestModel(custom_output_text="ok"), name="no-exporter")
        self.assertEqual(agent.run_sync("safe request").output, "ok")

    def test_exporter_failures_are_converted_to_failure_results(self) -> None:
        exporter = FailOpenSpanExporter(ExplodingExporter())
        self.assertIs(exporter.export([]), SpanExportResult.FAILURE)
        self.assertFalse(exporter.force_flush())
        exporter.shutdown()


if __name__ == "__main__":
    unittest.main()
