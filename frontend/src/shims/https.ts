// Browser shim for Node's built-in `https` module.
//
// Some transitive dependencies (e.g. `@switchboard-xyz/common`'s axios wrapper)
// do `import { Agent } from "https"` and construct `new Agent(...)` at module
// load time to set axios's `httpsAgent`. In the browser there is no Node `https`
// module — Vite externalizes it to `__vite-browser-external`, which exports
// nothing, so `new Agent()` throws and the build/bundle crashes.
//
// The browser XHR/fetch adapter ignores `httpsAgent` entirely, so a no-op Agent
// is a safe stand-in. This keeps Node-only networking internals out of browser
// code while letting the bundle build.
export class Agent {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts?: unknown) {}
}

export default { Agent };
