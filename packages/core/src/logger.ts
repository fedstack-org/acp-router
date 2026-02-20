import pino from 'pino'

export const logger = pino({
  name: 'acp-router',
  level: process.env.ACP_ROUTER_LOG_LEVEL ?? 'info'
})
