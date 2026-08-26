import assert from 'node:assert/strict';

import { EventBus } from '../dist/eventbus.js';
import { Logger } from '../dist/logger.js';

const bus = new EventBus();
const logger = new Logger(bus, 'epipe-test');
const entries = [];
bus.on('log', (entry) => entries.push(entry));

const originalLog = console.log;
console.log = () => {
  const error = new Error('broken pipe');
  error.code = 'EPIPE';
  throw error;
};

try {
  assert.doesNotThrow(() => logger.info('desktop-safe'));
} finally {
  console.log = originalLog;
}

assert.equal(entries.length, 1);
assert.equal(entries[0].message, 'desktop-safe');
assert.equal(entries[0].scope, 'epipe-test');

console.log('LOGGER CLOSED-PIPE TEST PASSED');
