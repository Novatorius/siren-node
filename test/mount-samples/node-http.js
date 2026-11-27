import http from 'node:http'
import { answers } from './answers.js'

http.createServer(answers).listen(3000)
