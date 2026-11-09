import { HttpGscClient } from "./http-client.js";
import type { GscClient } from "./port.js";

// STORY-115 - where the worker gets the real Google adapter. A factory rather than a module-level instance so a worker group that never
// runs `gsc.sync` builds nothing, and so a test that injects a fake never reaches this file.
export const GSC_CLIENT_FACTORY = (): GscClient => new HttpGscClient();
