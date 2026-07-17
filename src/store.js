import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canTransition } from './status.js';

function now() {
  return new Date().toISOString();
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parse(value) {
  return value == null ? null : JSON.parse(value);
}

export function fingerprint(message) {
  return createHash('sha256').update(JSON.stringify({
    sender_id: message.sender_id,
    channel: message.channel,
    destination: message.destination,
    text: message.text
  })).digest('hex');
}

export class MessageStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        client_ref TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        text TEXT NOT NULL,
        route TEXT NOT NULL,
        provider TEXT,
        provider_message_id TEXT,
        status TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_id ON messages(provider, provider_message_id)
        WHERE provider_message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_ref TEXT NOT NULL REFERENCES messages(client_ref),
        provider TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        error TEXT,
        raw_response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(client_ref, provider, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_ref TEXT NOT NULL REFERENCES messages(client_ref),
        event TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_receipts (
        event_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
  }

  createOrGet(message, route) {
    const requestFingerprint = fingerprint(message);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM messages WHERE client_ref = ?').get(message.client_ref);
      if (existing) {
        this.db.exec('COMMIT');
        return { created: false, message: this.hydrateMessage(existing), fingerprintMatches: existing.request_fingerprint === requestFingerprint };
      }
      this.db.prepare(`INSERT INTO messages
        (client_ref, sender_id, channel, destination, text, route, status, request_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?, ?)`)
        .run(message.client_ref, message.sender_id, message.channel, message.destination, message.text, route, requestFingerprint, timestamp, timestamp);
      this.addAudit(message.client_ref, 'message_accepted', null, 'ACCEPTED', { route });
      const created = this.db.prepare('SELECT * FROM messages WHERE client_ref = ?').get(message.client_ref);
      this.db.exec('COMMIT');
      return { created: true, message: this.hydrateMessage(created), fingerprintMatches: true };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* no transaction left to roll back */ }
      throw error;
    }
  }

  getMessage(clientRef) {
    const row = this.db.prepare('SELECT * FROM messages WHERE client_ref = ?').get(clientRef);
    return row ? this.hydrateMessage(row) : null;
  }

  getMessageByProviderId(provider, providerMessageId) {
    const row = this.db.prepare('SELECT * FROM messages WHERE provider = ? AND provider_message_id = ?').get(provider, providerMessageId);
    return row ? this.hydrateMessage(row) : null;
  }

  hydrateMessage(row) {
    return {
      ...row,
      attempts: this.db.prepare('SELECT * FROM attempts WHERE client_ref = ? ORDER BY id').all(row.client_ref).map((attempt) => ({ ...attempt, raw_response: parse(attempt.raw_response) })),
      audit_trail: this.db.prepare('SELECT * FROM audits WHERE client_ref = ? ORDER BY id').all(row.client_ref).map((audit) => ({ ...audit, details: parse(audit.details) }))
    };
  }

  addAudit(clientRef, event, fromStatus = null, toStatus = null, details = null) {
    this.db.prepare('INSERT INTO audits (client_ref, event, from_status, to_status, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clientRef, event, fromStatus, toStatus, json(details), now());
  }

  startAttempt(clientRef, provider) {
    const row = this.db.prepare('SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt FROM attempts WHERE client_ref = ? AND provider = ?').get(clientRef, provider);
    const attemptNumber = row.max_attempt + 1;
    const timestamp = now();
    const result = this.db.prepare(`INSERT INTO attempts (client_ref, provider, attempt_number, status, created_at, updated_at)
      VALUES (?, ?, ?, 'STARTED', ?, ?)`)
      .run(clientRef, provider, attemptNumber, timestamp, timestamp);
    this.addAudit(clientRef, 'provider_attempt_started', null, null, { provider, attempt_number: attemptNumber });
    return Number(result.lastInsertRowid);
  }

  finishAttempt(id, { status, providerMessageId = null, error = null, rawResponse = null }) {
    this.db.prepare('UPDATE attempts SET status = ?, provider_message_id = ?, error = ?, raw_response = ?, updated_at = ? WHERE id = ?')
      .run(status, providerMessageId, error, json(rawResponse), now(), id);
  }

  submitToProvider(clientRef, provider, providerMessageId, rawResponse) {
    const current = this.getMessage(clientRef);
    this.db.prepare('UPDATE messages SET provider = ?, provider_message_id = ?, last_error = NULL, updated_at = ? WHERE client_ref = ?')
      .run(provider, providerMessageId, now(), clientRef);
    this.transition(clientRef, 'SUBMITTED', 'provider_submitted', { provider, provider_message_id: providerMessageId, raw_response: rawResponse }, current.status);
  }

  transition(clientRef, nextStatus, event, details = null, expectedCurrent) {
    const message = this.getMessage(clientRef);
    if (!message) return false;
    const current = message.status;
    if (expectedCurrent && current !== expectedCurrent) return false;
    if (!canTransition(current, nextStatus)) return false;
    this.db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE client_ref = ?').run(nextStatus, now(), clientRef);
    this.addAudit(clientRef, event, current, nextStatus, details);
    return true;
  }

  failMessage(clientRef, error, event = 'provider_failed', details = null) {
    const message = this.getMessage(clientRef);
    if (!message || ['DELIVERED', 'FAILED'].includes(message.status)) return false;
    this.db.prepare('UPDATE messages SET status = ?, last_error = ?, updated_at = ? WHERE client_ref = ?')
      .run('FAILED', error, now(), clientRef);
    this.addAudit(clientRef, event, message.status, 'FAILED', details);
    return true;
  }

  claimWebhook(eventKey, provider) {
    const changes = this.db.prepare('INSERT OR IGNORE INTO webhook_receipts (event_key, provider, received_at) VALUES (?, ?, ?)')
      .run(eventKey, provider, now()).changes;
    return changes === 1;
  }

  listPendingOrbit() {
    return this.db.prepare(`SELECT client_ref FROM messages
      WHERE provider = 'orbit' AND status IN ('SUBMITTED', 'SENT') ORDER BY created_at`).all()
      .map((row) => row.client_ref);
  }

  close() {
    this.db.close();
  }
}
