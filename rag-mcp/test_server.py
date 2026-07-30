from __future__ import annotations

import unittest
from unittest.mock import patch

import server


class RAGMcpServerTest(unittest.TestCase):
    def test_initialize_and_tool_discovery(self) -> None:
        initialized = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        })
        self.assertEqual(initialized["result"]["serverInfo"]["name"], "ai-base-rag")

        legacy_initialized = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26"},
        })
        self.assertEqual(legacy_initialized["result"]["protocolVersion"], "2025-03-26")

        listed = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/list",
            "params": {},
        })
        self.assertEqual(
            [tool["name"] for tool in listed["result"]["tools"]],
            [
                "query_knowledge",
                "retrieve_knowledge_context",
                "list_knowledge_documents",
                "search_knowledge_labels",
                "get_knowledge_graph",
            ],
        )

    @patch("server.api_request")
    def test_query_tool_uses_references_without_chunk_content(self, request) -> None:
        request.return_value = {"response": "answer", "references": []}
        result = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "query_knowledge",
                "arguments": {"query": "什么是 AI Base？"},
            },
        })
        request.assert_called_once_with("/query", payload={
            "query": "什么是 AI Base？",
            "mode": "mix",
            "response_type": "Multiple Paragraphs",
            "top_k": 20,
            "include_references": True,
            "include_chunk_content": False,
        })
        self.assertFalse(result["result"]["isError"])
        self.assertEqual(result["result"]["structuredContent"]["response"], "answer")

    @patch("server.api_request")
    def test_document_tool_removes_content_summary(self, request) -> None:
        request.return_value = {
            "documents": [{
                "id": "doc-1",
                "file_path": "handbook.md",
                "status": "processed",
                "chunks_count": 2,
                "content_summary": "must not be returned",
            }],
            "pagination": {"total_count": 1},
            "status_counts": {"processed": 1},
        }
        result = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "list_knowledge_documents", "arguments": {}},
        })
        document = result["result"]["structuredContent"]["documents"][0]
        self.assertNotIn("content_summary", document)
        self.assertEqual(document["file_path"], "handbook.md")

    def test_invalid_tool_arguments_return_tool_error(self) -> None:
        result = server.dispatch_rpc({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "query_knowledge", "arguments": {"query": "x"}},
        })
        self.assertTrue(result["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
