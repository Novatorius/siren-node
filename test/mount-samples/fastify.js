import Fastify from 'fastify'
import { answers } from './answers.js'

const app = Fastify()
app.register(answers.fastify, { path: '/siren' })
await app.listen({ port: 3000 })
