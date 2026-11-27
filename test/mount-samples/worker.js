// A Cloudflare Worker. Bun, Deno and Hono take the same fetch handler.
import { answers } from './answers.js'

export default { fetch: answers }
