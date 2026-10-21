import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feathers } from '@feathersjs/feathers'
import { koa, rest, bodyParser, errorHandler, serveStatic } from '@feathersjs/koa'
import socketio from '@feathersjs/socketio'
import type { AppConfig } from './config'
import { filesMiddleware } from './http/files'
import { llmMiddleware } from './http/llm'
import type { Engine } from './jmeter/engine'
import { JobsService } from './services/jobs/jobs.class'

export interface AppOptions {
  config: AppConfig
  engine?: Engine
}

export function createApp(options: AppOptions) {
  const app = koa(feathers())
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public')
  app.use(errorHandler())
  app.use(bodyParser({ jsonLimit: '20mb' }))
  app.use(llmMiddleware(options.config))
  app.use(filesMiddleware(options.config))
  app.use(serveStatic(publicDir))
  app.configure(rest())
  app.configure(socketio({
    cors: { origin: true }
  }))

  const jobs = new JobsService(options.config, options.engine)
  app.use('jobs', jobs, { events: ['status'] })

  app.on('connection', (connection: unknown) => {
    app.channel('jobs').join(connection as never)
  })
  app.publish(() => app.channel('jobs'))

  return app
}
