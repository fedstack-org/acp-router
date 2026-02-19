import { EventEmitter } from "node:events";
import { AcpTransport } from "./acp.js";
import type { DroidConfig } from "./config.js";

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
}

export interface PermissionRequest {
  jsonRpcId: number;
  sessionId: string;
  toolCall: ToolCallInfo;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ConfigOptionValue[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface DroidSessionEvents {
  agent_message_chunk: (text: string) => void;
  thought_message_chunk: (text: string) => void;
  tool_call: (info: ToolCallInfo) => void;
  tool_call_update: (info: ToolCallInfo) => void;
  permission_request: (req: PermissionRequest) => void;
  turn_complete: (stopReason: string) => void;
  available_commands_update: (commands: AvailableCommand[]) => void;
  config_options_update: (options: ConfigOption[]) => void;
  error: (err: Error) => void;
  close: () => void;
  stderr: (text: string) => void;
}

export declare interface DroidSession {
  on<E extends keyof DroidSessionEvents>(event: E, listener: DroidSessionEvents[E]): this;
  emit<E extends keyof DroidSessionEvents>(event: E, ...args: Parameters<DroidSessionEvents[E]>): boolean;
}

export class DroidSession extends EventEmitter {
  private transport: AcpTransport | null = null;
  private sessionId: string | null = null;
  private _ready = false;
  private _configOptions: ConfigOption[] = [];
  private _availableCommands: AvailableCommand[] = [];

  constructor(private config: DroidConfig) {
    super();
  }

  get ready() {
    return this._ready && this.transport?.isAlive;
  }

  get configOptions(): ReadonlyArray<ConfigOption> {
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

    this.transport = new AcpTransport(["droid", ...args], {
      DROID_DISABLE_AUTO_UPDATE: "true",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    });

    this.transport.on("close", () => {
      this._ready = false;
      this.emit("close");
    });

    this.transport.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.transport.on("stderr", (text: string) => {
      this.emit("stderr", text);
    });

    this.transport.on("notification", (method: string, params: unknown) => {
      if (method === "session/update") {
        this.handleSessionUpdate(params);
      }
    });

    this.transport.onRequest("session/request_permission", async (params) => {
      return this.handlePermissionRequest(params);
    });

    const initResult = (await this.transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "acp-router",
        title: "ACP Router (Telegram)",
        version: "0.1.0",
      },
    })) as Record<string, unknown>;

    console.log("[droid] initialized, agent:", JSON.stringify(initResult.agentInfo));

    const sessionResult = (await this.transport.request("session/new", {
      cwd: this.config.cwd ?? process.cwd(),
      mcpServers: [],
    })) as { sessionId: string; configOptions?: ConfigOption[] };

    this.sessionId = sessionResult.sessionId;
    if (sessionResult.configOptions) {
      this._configOptions = sessionResult.configOptions;
    }
    this._ready = true;
    console.log("[droid] session created:", this.sessionId);
  }

  async prompt(text: string): Promise<string> {
    if (!this.transport || !this.sessionId) {
      throw new Error("DroidSession not initialized");
    }

    const result = (await this.transport.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason: string };

    return result.stopReason;
  }

  async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
    if (!this.transport || !this.sessionId) {
      throw new Error("DroidSession not initialized");
    }

    const result = (await this.transport.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    })) as { configOptions: ConfigOption[] };

    this._configOptions = result.configOptions;
    return result.configOptions;
  }

  private handleSessionUpdate(params: unknown) {
    const p = params as Record<string, unknown>;
    const update = p.update as Record<string, unknown>;
    if (!update) return;

    const updateType = update.sessionUpdate as string;

    switch (updateType) {
      case "agent_message_chunk": {
        const content = update.content as { type: string; text?: string };
        if (content?.text) {
          this.emit("agent_message_chunk", content.text);
        }
        break;
      }
      case "thought_message_chunk": {
        const content = update.content as { type: string; text?: string };
        if (content?.text) {
          this.emit("thought_message_chunk", content.text);
        }
        break;
      }
      case "tool_call": {
        this.emit("tool_call", {
          toolCallId: update.toolCallId as string,
          title: update.title as string,
          kind: update.kind as string | undefined,
          status: (update.status as string) ?? "pending",
        });
        break;
      }
      case "tool_call_update": {
        this.emit("tool_call_update", {
          toolCallId: update.toolCallId as string,
          title: (update.title as string) ?? "",
          kind: update.kind as string | undefined,
          status: (update.status as string) ?? "in_progress",
        });
        break;
      }
      case "available_commands_update": {
        const cmds = (update.availableCommands as AvailableCommand[]) ?? [];
        this._availableCommands = cmds;
        this.emit("available_commands_update", cmds);
        break;
      }
      case "config_options_update": {
        const opts = (update.configOptions as ConfigOption[]) ?? [];
        this._configOptions = opts;
        this.emit("config_options_update", opts);
        break;
      }
      case "plan": {
        break;
      }
    }
  }

  private handlePermissionRequest(params: unknown): Promise<unknown> {
    const p = params as {
      sessionId: string;
      toolCall: Record<string, unknown>;
      options: Array<{ optionId: string; name: string; kind: string }>;
    };

    return new Promise((resolve) => {
      const req: PermissionRequest = {
        jsonRpcId: 0,
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: (p.toolCall.toolCallId as string) ?? "",
          title: (p.toolCall.title as string) ?? "Unknown operation",
          kind: p.toolCall.kind as string | undefined,
          status: (p.toolCall.status as string) ?? "pending",
        },
        options: p.options,
      };

      this.permissionResolvers.set(req.toolCall.toolCallId, resolve);
      this.emit("permission_request", req);
    });
  }

  private permissionResolvers = new Map<string, (value: unknown) => void>();

  respondPermission(toolCallId: string, optionId: string) {
    const resolve = this.permissionResolvers.get(toolCallId);
    if (resolve) {
      this.permissionResolvers.delete(toolCallId);
      resolve({ outcome: { outcome: "selected", optionId } });
    }
  }

  rejectPermission(toolCallId: string) {
    const resolve = this.permissionResolvers.get(toolCallId);
    if (resolve) {
      this.permissionResolvers.delete(toolCallId);
      resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  cancel() {
    if (this.transport && this.sessionId) {
      this.transport.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  async close() {
    this._ready = false;
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}
