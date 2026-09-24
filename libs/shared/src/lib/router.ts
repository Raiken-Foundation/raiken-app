/**
 * tRPC router composition — transport adapters only.
 *
 * Business orchestration lives in `@raiken/core` application modules under
 * `libs/core/src/application/`. Domain procedure definitions are split under
 * `./router/` and composed here.
 */
export { type AppRouter, appRouter, type Context } from "./router/index";
