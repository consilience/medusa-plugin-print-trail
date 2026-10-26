// The HTTP harness's Medusa app: only this config. The plugin is loaded from
// the repo root by absolute path, which Medusa reads from .medusa/server, so
// the harness always runs after `npm run build`.
import path from "node:path"
import { defineConfig, loadEnv } from "@medusajs/framework/utils"
import { assertLocalPrintTrail, HARNESS, harnessOptions } from "../harness"

loadEnv("test", process.cwd())

const root = path.resolve(__dirname, "../../..")
const options = harnessOptions()
assertLocalPrintTrail(options.baseUrl as string | undefined)

const modules: Record<string, unknown>[] = [
  {
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [
        { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
        {
          resolve: path.join(root, ".medusa/server/src/providers/print-trail"),
          id: "print-trail",
          options: { baseUrl: options.baseUrl, channelId: options.channelId, apiToken: options.apiToken },
        },
      ],
    },
  },
  {
    resolve: "@medusajs/medusa/notification",
    options: {
      providers: [
        { resolve: "@medusajs/medusa/notification-local", id: "local", options: { channels: ["email"] } },
      ],
    },
  },
]

if (process.env.REDIS_URL) {
  modules.push({
    resolve: "@medusajs/medusa/locking",
    options: {
      providers: [
        {
          resolve: "@medusajs/medusa/locking-redis",
          id: "locking-redis",
          is_default: true,
          options: { redisUrl: process.env.REDIS_URL },
        },
      ],
    },
  })
}

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      jwtSecret: HARNESS.jwtSecret,
      cookieSecret: HARNESS.jwtSecret,
      storeCors: "*",
      adminCors: "*",
      authCors: "*",
    },
  },
  admin: { disable: true },
  plugins: [{ resolve: root, options }],
  modules,
})
