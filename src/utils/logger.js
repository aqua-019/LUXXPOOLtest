/**
 * LUXXPOOL — Structured Logger
 * Pino-based logging with context tagging
 */

const pino = require('pino');
const config = require('../../config');

const logger = pino({
  level: config.monitoring.logLevel,
  transport: config.env === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
  base: { pool: config.pool.name },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Create a child logger with a specific component tag
 * @param {string} component - Component name (e.g., 'stratum', 'payment')
 * @returns {pino.Logger}
 */
function createLogger(component) {
  return logger.child({ component });
}

module.exports = { logger, createLogger };
