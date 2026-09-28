import { defineHandler } from 'h3'
import { health } from '../utils/health.js'

// Liveness: open, and answers during startup too; it reports nothing a caller could act on.
export default defineHandler(event => health(event))
