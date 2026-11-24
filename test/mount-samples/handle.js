import { answers } from './answers.js'

// Any other server: hand handle() the method, headers and raw bytes, send its reply, then run after().
export async function serve(method, headers, rawBody, send) {
  const reply = await answers.handle({ method, headers, rawBody })
  send(reply.status, reply.headers, reply.body)
  if (reply.after) await reply.after()
}
