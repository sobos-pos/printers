import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { config } from '../config'
import { registerHealthRoutes } from './routes/health'
import { registerTableRoutes } from './routes/tables'
import { registerOrderRoutes } from './routes/orders'
import { registerClusterRoutes } from './routes/cluster'
import { registerKdsWebSocket } from './websocket/kds'

let server: ReturnType<typeof Fastify> | null = null

export async function startApiServer(): Promise<void> {
  if (server) return

  server = Fastify({ logger: false })
  await server.register(cors, { origin: true })
  await server.register(websocket)

  registerHealthRoutes(server)
  registerTableRoutes(server)
  registerOrderRoutes(server)
  registerClusterRoutes(server)
  registerKdsWebSocket(server)

  await server.listen({ host: config.localApiHost, port: config.localApiPort })
  console.log(`[API] Listening on http://${config.localApiHost}:${config.localApiPort}`)
}

export async function stopApiServer(): Promise<void> {
  if (server) {
    await server.close()
    server = null
  }
}

export function getApiServer() {
  return server
}
