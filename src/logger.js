const levels = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const sensitiveKeys = new Set([
  'authorization',
  'api_key',
  'bearer_token',
  'destination',
  'password',
  'secret',
  'signature',
  'text',
  'token',
  'webhook_secret'
]);

/**
 * Emits one-line JSON suitable for console collection platforms such as
 * Datadog, CloudWatch, ELK, or Azure Monitor. Request/message payloads and
 * credentials are redacted before output.
 */
export function createLogger({
  write = console.log,
  service = 'messaging-gateway',
  level = process.env.LOG_LEVEL || 'info',
  now = () => new Date().toISOString(),
  base = {}
} = {}) {
  const minimumLevel = levels[level] ?? levels.info;

  function emit(recordLevel, event, fields = {}) {
    if (levels[recordLevel] < minimumLevel) return null;
    const record = {
      timestamp: now(),
      level: recordLevel,
      service,
      event,
      ...sanitize(base),
      ...sanitize(fields)
    };
    write(JSON.stringify(record));
    return record;
  }

  return {
    debug(event, fields) { return emit('debug', event, fields); },
    info(event, fields) { return emit('info', event, fields); },
    warn(event, fields) { return emit('warn', event, fields); },
    error(event, fields) { return emit('error', event, fields); },
    child(fields) {
      return createLogger({ write, service, level, now, base: { ...base, ...fields } });
    }
  };
}

function sanitize(value, key = null) {
  if (key && sensitiveKeys.has(key.toLowerCase())) return '[REDACTED]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.code ? { code: value.code } : {})
    };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
  }
  return value;
}
