# ACP Router

ACP Router bridges IM platforms and ACP-compatible agents. It fetches agent definitions from the ACP Registry, launches the selected agent, and routes messages bidirectionally.

## Features

- ACP registry integration
- Abstract IM adapter (Telegram today, more later)
- Multi-content routing (text, image, audio, video, files)
- Session commands: `start`, `sessions`, `mode`, `model`, `config`, `agents`

## Repo Layout

- `packages/core` — ACP routing core, registry, launcher, content normalization
- `packages/adapters/telegram` — Telegram adapter
- `packages/cli` — CLI entry (bun for dev, tsc for build)

## Config

Create `~/.config/acp-router.json`:

```json
{
  "defaultAgentId": "droid",
  "allowList": [123456789],
  "telegramToken": "YOUR_BOT_TOKEN",
  "cwd": "/path/to/workdir",
  "agents": {
    "droid": {
      "command": "droid",
      "args": ["exec", "--output-format", "acp"],
      "env": {
        "DROID_DISABLE_AUTO_UPDATE": "true",
        "FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"
      }
    }
  }
}
```

## Dev

- `bun run dev`
- `bun run typecheck`

## Build

- `bun run build`
