import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
process.env.DBG='1'
void import('./test-assistant-skills-tmp')
