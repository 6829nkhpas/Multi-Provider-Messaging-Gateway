export const senderConfig = Object.freeze({
  NEXUS01: { route: 'nexus' },
  NEXUS02: { route: 'nexus' },
  ORBIT01: { route: 'orbit' },
  AUTO01: { route: 'failover' }
});

export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || './data/gateway.sqlite',
    nexus: {
      baseUrl: env.NEXUS_BASE_URL || null,
      bearerToken: env.NEXUS_BEARER_TOKEN || 'dev-nexus-token',
      webhookSecret: env.NEXUS_WEBHOOK_SECRET || 'dev-nexus-webhook-secret',
      maxRateLimitRetries: Number(env.NEXUS_MAX_RATE_LIMIT_RETRIES || 3),
      retryBaseMs: Number(env.NEXUS_RETRY_BASE_MS || 100),
      retryJitterMs: Number(env.NEXUS_RETRY_JITTER_MS || 50)
    },
    orbit: {
      baseUrl: env.ORBIT_BASE_URL || null,
      apiKey: env.ORBIT_API_KEY || 'dev-orbit-key'
    }
  };
}
