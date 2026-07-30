from __future__ import annotations

import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


LISTEN_ADDRESS = os.getenv("RAG_MCP_LISTEN_ADDRESS", "0.0.0.0")
LISTEN_PORT = int(os.getenv("RAG_MCP_PORT", "8080"))
MCP_PATH = "/mcp"
LIGHTRAG_URL = os.getenv("LIGHTRAG_URL", "http://lightrag:9621").rstrip("/")
LIGHTRAG_API_KEY = os.getenv("LIGHTRAG_API_KEY", "")
PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOL_VERSIONS = {PROTOCOL_VERSION, "2025-03-26", "2024-11-05"}
QUERY_MODES = {"local", "global", "hybrid", "naive", "mix"}
DOCUMENT_STATUSES = {"pending", "processing", "preprocessed", "processed", "failed"}
MAX_REQUEST_BYTES = 2 * 1024 * 1024


TOOLS: list[dict[str, Any]] = [
    {
        "name": "query_knowledge",
        "description": "基于企业知识库生成回答，并返回引用来源。",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "minLength": 3, "maxLength": 10000},
                "mode": {
                    "type": "string",
                    "enum": sorted(QUERY_MODES),
                    "default": "mix",
                    "description": "mix 适合大多数问答。",
                },
                "response_type": {
                    "type": "string",
                    "default": "Multiple Paragraphs",
                },
                "top_k": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "retrieve_knowledge_context",
        "description": "只检索企业知识库上下文，不调用模型生成最终回答。",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "minLength": 3, "maxLength": 10000},
                "mode": {
                    "type": "string",
                    "enum": sorted(QUERY_MODES),
                    "default": "mix",
                },
                "top_k": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "chunk_top_k": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_knowledge_documents",
        "description": "分页列出企业知识库文档及其索引状态，不返回文档正文。",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "page": {"type": "integer", "minimum": 1, "default": 1},
                "page_size": {"type": "integer", "minimum": 10, "maximum": 100, "default": 20},
                "status": {
                    "type": "string",
                    "enum": sorted(DOCUMENT_STATUSES),
                    "description": "可选的索引状态过滤。",
                },
            },
        },
    },
    {
        "name": "search_knowledge_labels",
        "description": "按名称搜索知识图谱中的实体标签。",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 200},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_knowledge_graph",
        "description": "读取指定实体标签周边的知识图谱节点与关系。",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "label": {"type": "string", "minLength": 1, "maxLength": 200},
                "max_depth": {"type": "integer", "minimum": 1, "maximum": 5, "default": 2},
                "max_nodes": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100},
            },
            "required": ["label"],
        },
    },
]


class LightRagApiError(RuntimeError):
    pass


def api_request(
    endpoint: str,
    *,
    payload: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    timeout: int = 120,
) -> Any:
    url = f"{LIGHTRAG_URL}{endpoint}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    headers = {"Accept": "application/json", "X-API-Key": LIGHTRAG_API_KEY}
    data = None
    method = "GET"
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            detail = str(parsed.get("detail") or parsed.get("error") or detail)
        except json.JSONDecodeError:
            pass
        raise LightRagApiError(f"LightRAG API 返回 HTTP {error.code}: {detail[:1000]}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise LightRagApiError(f"无法连接 LightRAG API: {error}") from error


def string_argument(
    arguments: dict[str, Any],
    name: str,
    *,
    minimum: int = 1,
    maximum: int = 10000,
    default: str | None = None,
) -> str:
    value = arguments.get(name, default)
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是字符串")
    value = value.strip()
    if len(value) < minimum or len(value) > maximum:
        raise ValueError(f"{name} 长度必须在 {minimum} 到 {maximum} 之间")
    return value


def integer_argument(
    arguments: dict[str, Any],
    name: str,
    *,
    minimum: int,
    maximum: int,
    default: int,
) -> int:
    value = arguments.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{name} 必须是 {minimum} 到 {maximum} 之间的整数")
    return value


def enum_argument(
    arguments: dict[str, Any],
    name: str,
    allowed: set[str],
    *,
    default: str,
) -> str:
    value = arguments.get(name, default)
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"{name} 必须是以下值之一: {', '.join(sorted(allowed))}")
    return value


def query_knowledge(arguments: dict[str, Any]) -> Any:
    return api_request("/query", payload={
        "query": string_argument(arguments, "query", minimum=3),
        "mode": enum_argument(arguments, "mode", QUERY_MODES, default="mix"),
        "response_type": string_argument(
            arguments,
            "response_type",
            maximum=100,
            default="Multiple Paragraphs",
        ),
        "top_k": integer_argument(arguments, "top_k", minimum=1, maximum=100, default=20),
        "include_references": True,
        "include_chunk_content": False,
    })


def retrieve_knowledge_context(arguments: dict[str, Any]) -> Any:
    return api_request("/query", payload={
        "query": string_argument(arguments, "query", minimum=3),
        "mode": enum_argument(arguments, "mode", QUERY_MODES, default="mix"),
        "top_k": integer_argument(arguments, "top_k", minimum=1, maximum=100, default=20),
        "chunk_top_k": integer_argument(
            arguments,
            "chunk_top_k",
            minimum=1,
            maximum=100,
            default=10,
        ),
        "only_need_context": True,
        "include_references": True,
        "include_chunk_content": False,
    })


def list_knowledge_documents(arguments: dict[str, Any]) -> Any:
    payload: dict[str, Any] = {
        "page": integer_argument(arguments, "page", minimum=1, maximum=100000, default=1),
        "page_size": integer_argument(
            arguments,
            "page_size",
            minimum=10,
            maximum=100,
            default=20,
        ),
        "sort_field": "updated_at",
        "sort_direction": "desc",
    }
    if arguments.get("status") is not None:
        payload["status_filter"] = enum_argument(
            arguments,
            "status",
            DOCUMENT_STATUSES,
            default="processed",
        )
    result = api_request("/documents/paginated", payload=payload, timeout=30)
    if not isinstance(result, dict):
        return result
    documents = []
    for document in result.get("documents", []):
        if not isinstance(document, dict):
            continue
        documents.append({
            key: document.get(key)
            for key in (
                "id",
                "file_path",
                "status",
                "content_length",
                "chunks_count",
                "created_at",
                "updated_at",
                "error_msg",
            )
            if document.get(key) is not None
        })
    return {
        "documents": documents,
        "pagination": result.get("pagination", {}),
        "status_counts": result.get("status_counts", {}),
    }


def search_knowledge_labels(arguments: dict[str, Any]) -> Any:
    return api_request("/graph/label/search", query={
        "q": string_argument(arguments, "query", maximum=200),
        "limit": integer_argument(arguments, "limit", minimum=1, maximum=100, default=20),
    }, timeout=30)


def get_knowledge_graph(arguments: dict[str, Any]) -> Any:
    return api_request("/graphs", query={
        "label": string_argument(arguments, "label", maximum=200),
        "max_depth": integer_argument(arguments, "max_depth", minimum=1, maximum=5, default=2),
        "max_nodes": integer_argument(arguments, "max_nodes", minimum=1, maximum=200, default=100),
    }, timeout=60)


TOOL_HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "query_knowledge": query_knowledge,
    "retrieve_knowledge_context": retrieve_knowledge_context,
    "list_knowledge_documents": list_knowledge_documents,
    "search_knowledge_labels": search_knowledge_labels,
    "get_knowledge_graph": get_knowledge_graph,
}


def tool_result(value: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    result: dict[str, Any] = {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }
    if isinstance(value, dict):
        result["structuredContent"] = value
    return result


def json_rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def dispatch_rpc(request: Any) -> dict[str, Any] | None:
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        return json_rpc_error(None, -32600, "Invalid Request")
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params", {})
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        requested_version = params.get("protocolVersion") if isinstance(params, dict) else None
        protocol_version = (
            requested_version
            if requested_version in SUPPORTED_PROTOCOL_VERSIONS
            else PROTOCOL_VERSION
        )
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "ai-base-rag", "version": "1.0.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        if not isinstance(params, dict):
            return json_rpc_error(request_id, -32602, "Invalid tools/call params")
        name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(name, str) or name not in TOOL_HANDLERS:
            return json_rpc_error(request_id, -32602, "Unknown tool")
        if not isinstance(arguments, dict):
            return json_rpc_error(request_id, -32602, "Tool arguments must be an object")
        try:
            result = TOOL_HANDLERS[name](arguments)
            return {"jsonrpc": "2.0", "id": request_id, "result": tool_result(result)}
        except (ValueError, LightRagApiError) as error:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": tool_result({"error": str(error)}, is_error=True),
            }
        except Exception:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": tool_result({"error": "RAG 工具执行失败"}, is_error=True),
            }
    if request_id is None:
        return None
    return json_rpc_error(request_id, -32601, "Method not found")


class McpHandler(BaseHTTPRequestHandler):
    server_version = "AIBaseRAGMCP/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[rag-mcp] {self.address_string()} {format_string % args}", flush=True)

    def send_json(self, status: int, payload: Any | None = None) -> None:
        encoded = (
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if payload is not None
            else b""
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("MCP-Protocol-Version", PROTOCOL_VERSION)
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def authorized(self) -> bool:
        supplied = self.headers.get("X-API-Key", "")
        return bool(LIGHTRAG_API_KEY) and hmac.compare_digest(supplied, LIGHTRAG_API_KEY)

    def do_POST(self) -> None:
        if urllib.parse.urlsplit(self.path).path != MCP_PATH:
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
                raise ValueError("request body size is invalid")
            payload = json.loads(self.rfile.read(content_length))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, json_rpc_error(None, -32700, str(error)))
            return

        if isinstance(payload, list):
            if not payload:
                self.send_json(400, json_rpc_error(None, -32600, "Invalid Request"))
                return
            responses = [response for item in payload if (response := dispatch_rpc(item)) is not None]
            self.send_json(200 if responses else 202, responses or None)
            return

        response = dispatch_rpc(payload)
        self.send_json(200 if response is not None else 202, response)

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/health":
            try:
                result = api_request("/health", timeout=3)
                healthy = isinstance(result, dict) and result.get("status") == "healthy"
                self.send_json(200 if healthy else 503, {
                    "status": "healthy" if healthy else "unhealthy",
                    "upstream": result.get("status") if isinstance(result, dict) else "invalid",
                })
            except LightRagApiError as error:
                self.send_json(503, {"status": "unhealthy", "error": str(error)})
            return
        self.send_response(405)
        self.send_header("Allow", "POST")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    if not LIGHTRAG_API_KEY:
        raise RuntimeError("LIGHTRAG_API_KEY is required")
    server = ThreadingHTTPServer((LISTEN_ADDRESS, LISTEN_PORT), McpHandler)
    print(f"[rag-mcp] listening on {LISTEN_ADDRESS}:{LISTEN_PORT}{MCP_PATH}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
