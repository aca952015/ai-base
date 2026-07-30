from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


CONFIG_FILE = Path(os.getenv("LIGHTRAG_CONFIG_FILE", "/app/data/config/lightrag-config.json"))
ADMIN_HOST = os.getenv("LIGHTRAG_ADMIN_HOST", "0.0.0.0")
ADMIN_PORT = int(os.getenv("LIGHTRAG_ADMIN_PORT", "9622"))
ADMIN_TOKEN = os.getenv("LIGHTRAG_ADMIN_TOKEN", "")
CHILD_HEALTH_URL = os.getenv("LIGHTRAG_CHILD_HEALTH_URL", "http://127.0.0.1:9621/health")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def integer_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def default_config() -> dict[str, Any]:
    return {
        "llmModel": os.getenv("LLM_MODEL", "qwen"),
        "embeddingModel": os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3"),
        "embeddingDimension": integer_env("EMBEDDING_DIM", 1024),
        "embeddingTokenLimit": integer_env("EMBEDDING_TOKEN_LIMIT", 8192),
        "summaryLanguage": os.getenv("SUMMARY_LANGUAGE", "Chinese"),
        "maxAsync": integer_env("MAX_ASYNC", 4),
        "maxParallelInsert": integer_env("MAX_PARALLEL_INSERT", 2),
        "chunkSize": integer_env("CHUNK_SIZE", 1200),
        "chunkOverlapSize": integer_env("CHUNK_OVERLAP_SIZE", 100),
        "revision": "bootstrap",
        "updatedAt": utc_now(),
    }


def validate_model(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > 200 or any(character.isspace() for character in normalized):
        raise ValueError(f"{field} is invalid")
    return normalized


def validate_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return value


def validate_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("config must be an object")
    allowed = {
        "llmModel",
        "embeddingModel",
        "embeddingDimension",
        "embeddingTokenLimit",
        "summaryLanguage",
        "maxAsync",
        "maxParallelInsert",
        "chunkSize",
        "chunkOverlapSize",
        "revision",
        "updatedAt",
    }
    unsupported = sorted(set(value) - allowed)
    if unsupported:
        raise ValueError(f"unsupported fields: {', '.join(unsupported)}")

    chunk_size = validate_integer(value.get("chunkSize"), "chunkSize", 256, 8000)
    chunk_overlap = validate_integer(
        value.get("chunkOverlapSize"),
        "chunkOverlapSize",
        0,
        min(2000, chunk_size - 1),
    )
    summary_language = value.get("summaryLanguage")
    if summary_language not in {"Chinese", "English"}:
        raise ValueError("summaryLanguage must be Chinese or English")

    return {
        "llmModel": validate_model(value.get("llmModel"), "llmModel"),
        "embeddingModel": validate_model(value.get("embeddingModel"), "embeddingModel"),
        "embeddingDimension": validate_integer(
            value.get("embeddingDimension"),
            "embeddingDimension",
            1,
            65535,
        ),
        "embeddingTokenLimit": validate_integer(
            value.get("embeddingTokenLimit"),
            "embeddingTokenLimit",
            256,
            131072,
        ),
        "summaryLanguage": summary_language,
        "maxAsync": validate_integer(value.get("maxAsync"), "maxAsync", 1, 32),
        "maxParallelInsert": validate_integer(
            value.get("maxParallelInsert"),
            "maxParallelInsert",
            1,
            16,
        ),
        "chunkSize": chunk_size,
        "chunkOverlapSize": chunk_overlap,
        "revision": str(value.get("revision") or "bootstrap"),
        "updatedAt": str(value.get("updatedAt") or utc_now()),
    }


def atomic_write(config: dict[str, Any]) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_FILE.with_name(f"{CONFIG_FILE.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(f"{json.dumps(config, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        temporary.replace(CONFIG_FILE)
    finally:
        temporary.unlink(missing_ok=True)


def load_config() -> dict[str, Any]:
    if CONFIG_FILE.exists():
        return validate_config(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
    config = validate_config(default_config())
    atomic_write(config)
    return config


class LightRagProcess:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.process: subprocess.Popen[bytes] | None = None
        self.config = load_config()
        self.stopping = False

    def child_environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update({
            "LLM_MODEL": self.config["llmModel"],
            "EMBEDDING_MODEL": self.config["embeddingModel"],
            "EMBEDDING_DIM": str(self.config["embeddingDimension"]),
            "EMBEDDING_TOKEN_LIMIT": str(self.config["embeddingTokenLimit"]),
            "SUMMARY_LANGUAGE": self.config["summaryLanguage"],
            "MAX_ASYNC": str(self.config["maxAsync"]),
            "MAX_PARALLEL_INSERT": str(self.config["maxParallelInsert"]),
            "CHUNK_SIZE": str(self.config["chunkSize"]),
            "CHUNK_OVERLAP_SIZE": str(self.config["chunkOverlapSize"]),
        })
        return environment

    def start(self) -> None:
        with self.lock:
            if self.stopping or (self.process and self.process.poll() is None):
                return
            self.process = subprocess.Popen(
                [sys.executable, "-m", "lightrag.api.lightrag_server"],
                env=self.child_environment(),
            )

    def stop(self) -> None:
        with self.lock:
            process = self.process
            self.process = None
        if not process or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def child_healthy(self) -> bool:
        with self.lock:
            process = self.process
        if not process or process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(CHILD_HEALTH_URL, timeout=2) as response:
                return 200 <= response.status < 300
        except Exception:
            return False

    def wait_until_healthy(self, timeout: int = 90) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.child_healthy():
                return True
            time.sleep(1)
        return False

    def restart_with(self, candidate: dict[str, Any]) -> dict[str, Any]:
        next_config = validate_config({
            **candidate,
            "revision": uuid.uuid4().hex,
            "updatedAt": utc_now(),
        })
        with self.lock:
            previous = self.config
            atomic_write(next_config)
            self.config = next_config
            self.stop()
            self.start()
        if self.wait_until_healthy():
            return self.config

        with self.lock:
            atomic_write(previous)
            self.config = previous
            self.stop()
            self.start()
        recovered = self.wait_until_healthy()
        suffix = "；旧配置已恢复" if recovered else "；旧配置恢复失败"
        raise RuntimeError(f"LightRAG 未能使用新配置恢复健康{suffix}")

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            process = self.process
            config = dict(self.config)
        return {
            "ready": self.child_healthy(),
            "pid": process.pid if process and process.poll() is None else None,
            "config": config,
        }

    def monitor(self) -> None:
        while not self.stopping:
            with self.lock:
                stopped = not self.process or self.process.poll() is not None
            if stopped:
                self.start()
            time.sleep(2)

    def shutdown(self) -> None:
        self.stopping = True
        self.stop()


manager = LightRagProcess()


class AdminHandler(BaseHTTPRequestHandler):
    server_version = "AIBaseLightRAGControl/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[lightrag-control] {self.address_string()} {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self) -> bool:
        expected = f"Bearer {ADMIN_TOKEN}"
        return bool(ADMIN_TOKEN) and self.headers.get("Authorization") == expected

    def require_authorization(self) -> bool:
        if self.authorized():
            return True
        self.send_json(401, {"error": "unauthorized"})
        return False

    def do_GET(self) -> None:
        if self.path == "/health":
            snapshot = manager.snapshot()
            self.send_json(200 if snapshot["ready"] else 503, snapshot)
            return
        if self.path == "/config":
            if not self.require_authorization():
                return
            self.send_json(200, manager.snapshot())
            return
        self.send_json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        if self.path != "/config":
            self.send_json(404, {"error": "not found"})
            return
        if not self.require_authorization():
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 65536:
                raise ValueError("request body size is invalid")
            candidate = json.loads(self.rfile.read(content_length))
            config = manager.restart_with(candidate)
            self.send_json(200, {
                "ready": True,
                "config": config,
                "message": "LightRAG 配置已应用并恢复健康",
            })
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(503, {"error": str(error), **manager.snapshot()})


def main() -> None:
    if not ADMIN_TOKEN:
        raise RuntimeError("LIGHTRAG_ADMIN_TOKEN is required")

    manager.start()
    monitor = threading.Thread(target=manager.monitor, name="lightrag-monitor", daemon=True)
    monitor.start()
    server = ThreadingHTTPServer((ADMIN_HOST, ADMIN_PORT), AdminHandler)
    server_thread = threading.Thread(target=server.serve_forever, name="lightrag-admin", daemon=True)
    server_thread.start()
    stopping = threading.Event()

    def handle_signal(signum: int, frame: object) -> None:
        del signum, frame
        stopping.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        stopping.wait()
    finally:
        server.shutdown()
        server.server_close()
        manager.shutdown()


if __name__ == "__main__":
    main()
