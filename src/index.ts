import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const app = createApp({ config })
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  app.listen(config.port, config.host).then((server) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    console.log(`Feathers Wand UI at http://${config.host}:${port}`)
  })
}

export { app, config }
