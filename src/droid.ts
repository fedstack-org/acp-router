import { EventEmitter } from "node:events";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type SessionConfigOption,
  type AvailableCommand,
  type ToolCallUpdate,
  type ToolKind,
  type ToolCallStatus,
  type InitializeResponse,
  type NewSessionResponse,
  type SessionConfigSelectOption,
  type SessionConfigSelectGroup,
} from "@agentclientprotocol/sdk";
import type { DroidConfig } from "./config.js";

export type { SessionConfigOption, AvailableCommand, ToolKind, ToolCallStatus };

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: RequestPermissionRequest["options"];
  resolve: (response: RequestPermissionResponse) => void;
}

export interface DroidSessionEvents {
  agent_message_chunk: (text: string) => void;
  thought_message_chunk: (text: string) => void;
  tool_call: (info: ToolCallInfo) => void;
  tool_call_update: (info: ToolCallInfo) => void;
  permission_request: (req: PermissionRequest) => void;
  available_commands_update: (commands: AvailableCommand[]) => void;
  config_options_update: (options: SessionConfigOption[]) => void;
  error: (err: Error) => void;
  close: () => void;
  stderr: (text: string) => void;
}

export declare interface DroidSession {
  on<E extends keyof DroidSessionEvents>(event: E, listener: DroidSessionEvents[E]): this;
  emit<E extends keyof DroidSessionEvents>(event: E, ...args: Parameters<DroidSessionEvents[E]>): boolean;
}

export function flattenConfigOptions(opt: SessionConfigOption): SessionConfigSelectOption[] {
  const items = opt.options;
  if (items.length === 0) return [];
  if ("group" in items[0]) {
    return (items as SessionConfigSelectGroup[]).flatMap((g) => g.options);
  }
  return items as SessionConfigSelectOption[];
}

export class DroidSession extends EventEmitter {
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private _ready = false;
  private _configOptions: SessionConfigOption[] = [];
  private _availableCommands: AvailableCommand[] = [];

  constructor(private config: DroidConfig) {
    super();
  }

  get ready() {
    return this._ready && this.connection !== null && !this.connection.signal.aborted;
  }

  get configOptions(): ReadonlyArray<SessionConfigOption> {
    return this._configOptions;
  }

  get availableCommands(): ReadonlyArray<AvailableCommand> {
    return this._availableCommands;
  }

  async initialize(): Promise<void> {
    const args = ["exec", "--output-format", "acp"];
    if (this.config.model) args.push("-m", this.config.model);
    if (this.config.autoLevel) args.push("--auto", this.config.autoLevel);
    if (this.config.reasoningEffort) args.push("-r", this.config.reasoningEffort);

    this.proc = Bun.spawn(["droid", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DROID_DISABLE_AUTO_UPDATE: "true",
        FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
      },
    });

    this.readStderr();

    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    const stdin = this.proc.stdin as unknown as { write(data: string | Uint8Array): number; flush(): void; end(): void };

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        stdin.write(chunk);
      },
      close() {
        stdin.end();
      },
    });

    const stream = ndJsonStream(writable, stdout);
    const self = this;

    this.connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
          return new Promise<RequestPermissionResponse>((resolve) => {
            self.emit("permission_request", {
              sessionId: params.sessionId,
              toolCall: params.toolCall,
              options: params.options,
              resolve,
            } satisfies PermissionRequest);
          });
        },
        async sessionUpdate(params: SessionNotification): Promise<void> {
          self.handleSessionUpdate(params.update);
        },
      }),
      stream,
    );

    this.connection.signal.addEventListener("abort", () => {
      this._ready = false;
      this.emit("close");
    });

    const initResult: InitializeResponse = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "acp-router",
        title: "ACP Router (Telegram)",
        version: "0.1.0",
      },
    });

    console.log("[droid] === Initialize Response ===");
    console.log("[droid] Protocol version:", initResult.protocolVersion);
    console.log("[droid] Agent info:", JSON.stringify(initResult.agentInfo, null, 2));
    console.log("[droid] Agent capabilities:", JSON.stringify(initResult.agentCapabilities, null, 2));
    if (initResult.authMethods) {
      console.log("[droid] Auth methods:", JSON.stringify(initResult.authMethods, null, 2));
    }

    const sessionResult: NewSessionResponse = await this.connection.newSession({
      cwd: this.config.cwd ?? process.cwd(),
      mcpServers: [],
    });

    this.sessionId = sessionResult.sessionId;
    console.log("[droid] === Session Created ===");
    console.log("[droid] Session ID:", this.sessionId);

    if (sessionResult.configOptions) {
      this._configOptions = sessionResult.configOptions;
      this.logConfigOptions(this._configOptions);
    }

    if (sessionResult.modes) {
      console.log("[droid] Modes:", JSON.stringify(sessionResult.modes, null, 2));
    }

    this._ready = true;
  }

  async prompt(text: string): Promise<string> {
    if (!this.connection || !this.sessionId) {
      throw new Error("DroidSession not initialized");
    }

    const result = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    return result.stopReason;
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (!this.connection || !this.sessionId) {
      throw new Error("DroidSession not initialized");
    }

    const result = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId,
      value,
    });

    this._configOptions = result.configOptions;
    return result.configOptions;
  }

  respondPermission(req: PermissionRequest, optionId: string) {
    req.resolve({ outcome: { outcome: "selected", optionId } });
  }

  rejectPermission(req: PermissionRequest) {
    req.resolve({ outcome: { outcome: "cancelled" } });
  }

  cancel() {
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  async close() {
    this._ready = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.connection = null;
  }

  private handleSessionUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.emit("agent_message_chunk", update.content.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.emit("thought_message_chunk", update.content.text);
        }
        break;
      }
      case "tool_call": {
        this.emit("tool_call", {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
        });
        break;
      }
      case "tool_call_update": {
        this.emit("tool_call_update", {
          toolCallId: update.toolCallId,
          title: update.title ?? "",
          kind: update.kind ?? undefined,
          status: update.status ?? undefined,
        });
        break;
      }
      case "available_commands_update": {
        this._availableCommands = update.availableCommands;
        console.log("[droid] Available commands updated:", update.availableCommands.map((c) => c.name).join(", "));
        this.emit("available_commands_update", update.availableCommands);
        break;
      }
      case "config_option_update": {
        this._configOptions = update.configOptions;
        console.log("[droid] Config options updated:");
        this.logConfigOptions(update.configOptions);
        this.emit("config_options_update", update.configOptions);
        break;
      }
      case "plan":
      case "user_message_chunk":
      case "current_mode_update":
      case "session_info_update":
      case "usage_update":
        break;
    }
  }

  private logConfigOptions(options: SessionConfigOption[]) {
    console.log("[droid] Config options:");
    for (const opt of options) {
      const flat = flattenConfigOptions(opt);
      const values = flat.map((v) =>
        v.value === opt.currentValue ? `[${v.name}]` : v.name,
      );
      console.log(`[droid]   ${opt.id} (${opt.category ?? "none"}): ${values.join(", ")}`);
    }
  }

  private async readStderr() {
    if (!this.proc) return;
    const stderr = this.proc.stderr as ReadableStream<Uint8Array>;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          this.emit("stderr", text);
        }
      }
    } catch {
      // stream closed
    }
  }
}
