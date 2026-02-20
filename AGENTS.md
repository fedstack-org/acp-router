# Agent Instructions

## Package Manager

Use **Yarn 4** (Corepack): `yarn install`, `yarn build`

## Build & Typecheck

```bash
yarn build        # tsc -b tsconfig.json (project references)
yarn typecheck    # same command
```

No test runner or linter configured yet.

## Monorepo Structure

| Package                        | Path                        | Description                                                          |
| ------------------------------ | --------------------------- | -------------------------------------------------------------------- |
| `@acp-router/core`             | `packages/core`             | Router, IM adapter interface, ACP agent registry, session management |
| `@acp-router/adapter-telegram` | `packages/adapter-telegram` | Telegram adapter using grammY                                        |
| `@acp-router/cli`              | `packages/cli`              | CLI entrypoint, config loading, cache                                |

Workspace protocol: `workspace:*` for inter-package deps.

## Key Conventions

- ESM only (`"type": "module"`)
- TypeScript strict mode, target ES2022, `moduleResolution: "bundler"`
- Output to `lib/` per package
- Config validated with Zod
- Logging via pino
- ACP SDK: `@agentclientprotocol/sdk`
