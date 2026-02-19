import { EventEmitter } from "node:events";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

type RequestHandler = (params: unknown) => Promise<unknown>;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}

export class AcpTransport extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandlers = new Map<string, RequestHandler>();
  private buffer = "";
  private closed = false;
  private stdout: ReadableStream<Uint8Array>;
  private stderr: ReadableStream<Uint8Array>;
  private stdin: { write(data: string | Uint8Array): number; flush(): void; end(): void };
  private proc: ReturnType<typeof Bun.spawn>;

  constructor(command: string[], env: Record<string, string>) {
    super();
    const proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    this.proc = proc;
    this.stdout = proc.stdout as ReadableStream<Uint8Array>;
    this.stderr = proc.stderr as ReadableStream<Uint8Array>;
    this.stdin = proc.stdin as unknown as typeof this.stdin;

    this.readLoop();
    this.readStderr();
  }

  private async readLoop() {
    const reader = this.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // stream closed
    } finally {
      this.closed = true;
      this.emit("close");
      for (const [, p] of this.pending) {
        p.reject(new Error("Transport closed"));
      }
      this.pending.clear();
    }
  }

  private async readStderr() {
    const reader = this.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.emit("stderr", text);
      }
    } catch {
      // stream closed
    }
  }

  private processBuffer() {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("error", new Error(`Failed to parse JSON-RPC message: ${line}`));
        continue;
      }

      this.handleMessage(msg);
    }
  }

  private async handleMessage(msg: JsonRpcMessage) {
    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (isRequest(msg)) {
      const handler = this.requestHandlers.get(msg.method);
      if (handler) {
        try {
          const result = await handler(msg.params);
          this.writeMessage({ jsonrpc: "2.0", id: msg.id, result });
        } catch (err) {
          this.writeMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      } else {
        this.writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      }
    } else if (isNotification(msg)) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  private writeMessage(msg: unknown) {
    if (this.closed) return;
    const data = JSON.stringify(msg) + "\n";
    this.stdin.write(data);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("Transport closed");

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: RequestHandler) {
    this.requestHandlers.set(method, handler);
  }

  async close() {
    this.closed = true;
    try {
      this.stdin.end();
    } catch {
      // ignore
    }
    this.proc.kill();
  }

  get isAlive() {
    return !this.closed;
  }
}
