/* ═══════════════════════════════════════════════
   Multi-Provider Messaging Gateway — Dashboard JS
   ═══════════════════════════════════════════════ */

const API = '';
const WEBHOOK_SECRET = 'dev-nexus-webhook-secret';

// ── State ──
const sentMessages = [];
let lastNexusProviderMsgId = null;

// ── DOM Refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSendForm();
  initLookupForm();
  initWebhookForm();
  initPollButton();
  initSenderHint();
  initCharCount();
  generateRef();
});

// ═══════════════════
//  TABS
// ═══════════════════
function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ═══════════════════
//  SEND MESSAGE
// ═══════════════════
function initSendForm() {
  $('#genRef').addEventListener('click', generateRef);
  $('#sendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#sendBtn');
    setLoading(btn, true);

    const body = {
      client_ref: $('#clientRef').value.trim(),
      sender_id: $('#senderId').value,
      channel: 'sms',
      destination: $('#destination').value.trim(),
      text: $('#msgText').value,
    };

    const { data, status, duration } = await apiCall('POST', '/v1/messages', body);
    setLoading(btn, false);
    showResponse('POST /v1/messages', 'POST', status, duration, data);

    if (status === 200 && data) {
      sentMessages.push(data.client_ref);
      updateRecentRefs();
      updateStateMachine(data.status);
      showAuditTrail(data.audit_trail);
      showAttempts(data.attempts);

      if (data.provider === 'nexus' && data.provider_message_id) {
        lastNexusProviderMsgId = data.provider_message_id;
        $('#whMsgId').value = data.provider_message_id;
      }

      generateRef();
    }
  });
}

function generateRef() {
  const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  $('#clientRef').value = id;
}

// ═══════════════════
//  SENDER HINT
// ═══════════════════
const routeHints = {
  NEXUS01: { badge: 'badge-nexus', text: 'Routes exclusively to NexusSMS with Bearer auth' },
  NEXUS02: { badge: 'badge-nexus', text: 'Routes exclusively to NexusSMS with Bearer auth' },
  ORBIT01: { badge: 'badge-orbit', text: 'Routes exclusively to OrbitMsg with API key' },
  AUTO01: { badge: 'badge-failover', text: 'Nexus first → Orbit exactly once on 5xx/timeout' },
};

const routeLabels = {
  NEXUS01: 'nexus', NEXUS02: 'nexus', ORBIT01: 'orbit', AUTO01: 'failover',
};

function initSenderHint() {
  const sel = $('#senderId');
  const hint = $('#routeHint');
  const update = () => {
    const info = routeHints[sel.value];
    if (info) {
      hint.innerHTML = `<span class="badge ${info.badge}">${routeLabels[sel.value]}</span> ${info.text}`;
    }
  };
  sel.addEventListener('change', update);
  update();
}

// ═══════════════════
//  CHAR COUNT
// ═══════════════════
function initCharCount() {
  const textarea = $('#msgText');
  const counter = $('#charCount');
  const update = () => { counter.textContent = textarea.value.length; };
  textarea.addEventListener('input', update);
  update();
}

// ═══════════════════
//  LOOKUP
// ═══════════════════
function initLookupForm() {
  $('#lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#lookupBtn');
    setLoading(btn, true);

    const ref = $('#lookupRef').value.trim();
    const { data, status, duration } = await apiCall('GET', `/v1/messages/${encodeURIComponent(ref)}`);
    setLoading(btn, false);
    showResponse(`GET /v1/messages/${ref}`, 'GET', status, duration, data);

    if (status === 200 && data) {
      updateStateMachine(data.status);
      showAuditTrail(data.audit_trail);
      showAttempts(data.attempts);
    }
  });
}

function updateRecentRefs() {
  const container = $('#recentRefs');
  container.innerHTML = '';
  const unique = [...new Set(sentMessages)].slice(-8).reverse();
  unique.forEach((ref) => {
    const chip = document.createElement('span');
    chip.className = 'ref-chip';
    chip.textContent = ref;
    chip.addEventListener('click', () => { $('#lookupRef').value = ref; });
    container.appendChild(chip);
  });
}

// ═══════════════════
//  WEBHOOK
// ═══════════════════
function initWebhookForm() {
  $('#webhookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#webhookBtn');
    setLoading(btn, true);

    const payload = {
      message_id: $('#whMsgId').value.trim(),
      status: $('#whStatus').value,
    };

    const bodyStr = JSON.stringify(payload);
    const signature = await hmacSHA256(bodyStr, WEBHOOK_SECRET);

    const { data, status, duration } = await apiCall('POST', '/webhooks/nexus/status', payload, {
      'x-nexus-signature': `sha256=${signature}`,
      'x-nexus-event-id': `demo-evt-${Date.now()}`,
    });
    setLoading(btn, false);
    showResponse('POST /webhooks/nexus/status', 'POST', status, duration, data);

    if (status === 200 && data?.message) {
      updateStateMachine(data.message.status);
      showAuditTrail(data.message.audit_trail);
      showAttempts(data.message.attempts);
    }
  });
}

// ═══════════════════
//  DLR POLL
// ═══════════════════
function initPollButton() {
  $('#pollBtn').addEventListener('click', async () => {
    const btn = $('#pollBtn');
    setLoading(btn, true);
    const { data, status, duration } = await apiCall('POST', '/v1/dlr/poll');
    setLoading(btn, false);
    showResponse('POST /v1/dlr/poll', 'POST', status, duration, data);
  });
}

// ═══════════════════
//  API CALL
// ═══════════════════
async function apiCall(method, path, body = undefined, extraHeaders = {}) {
  const opts = {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const start = performance.now();
  let res, text;
  try {
    res = await fetch(`${API}${path}`, opts);
    text = await res.text();
  } catch (err) {
    return { data: { error: { code: 'NETWORK_ERROR', message: err.message } }, status: 0, duration: performance.now() - start };
  }
  const duration = performance.now() - start;
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, status: res.status, duration };
}

// ═══════════════════
//  RESPONSE DISPLAY
// ═══════════════════
function showResponse(title, method, status, duration, data) {
  $('#outputTitle').textContent = title;
  $('#httpMethod').textContent = method;

  const statusEl = $('#httpStatus');
  statusEl.textContent = status || 'ERR';
  statusEl.className = 'http-status';
  if (status >= 200 && status < 300) statusEl.classList.add('s2xx');
  else if (status >= 400 && status < 500) statusEl.classList.add('s4xx');
  else statusEl.classList.add('s5xx');

  $('#httpTime').textContent = `${Math.round(duration)}ms`;

  const viewer = $('#responseViewer');
  const code = $('#responseCode');
  code.innerHTML = syntaxHighlight(data);
  viewer.classList.remove('fresh');
  void viewer.offsetWidth; // force reflow
  viewer.classList.add('fresh');
}

function syntaxHighlight(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${escapeHtml(match)}</span>`;
    }
  );
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════
//  STATE MACHINE
// ═══════════════════
const STATE_ORDER = ['ACCEPTED', 'SUBMITTED', 'SENT', 'DELIVERED'];

function updateStateMachine(currentStatus) {
  const nodes = $$('.sm-node');
  const edges = $$('.sm-edge');
  const branch = $('.sm-branch');

  // Reset
  nodes.forEach((n) => { n.classList.remove('active', 'reached'); });
  edges.forEach((e) => { e.classList.remove('reached'); });
  branch.classList.remove('reached');

  if (currentStatus === 'FAILED') {
    // Highlight up to the last known state before failure + FAILED node
    const failedNode = $('.sm-failed');
    failedNode.classList.add('active');
    branch.classList.add('reached');
    // Mark all states up to where we were (at least ACCEPTED)
    const acceptedIdx = 0;
    for (let i = 0; i <= acceptedIdx; i++) {
      const stateNode = $(`.sm-node[data-state="${STATE_ORDER[i]}"]`);
      if (stateNode) stateNode.classList.add('reached');
    }
    $('#smCaption').textContent = 'Message has FAILED — terminal state reached';
    return;
  }

  const activeIdx = STATE_ORDER.indexOf(currentStatus);
  if (activeIdx === -1) return;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const state = node.dataset.state;
    if (!state) continue;
    const stateIdx = STATE_ORDER.indexOf(state);
    if (stateIdx === -1) continue;

    if (stateIdx < activeIdx) {
      node.classList.add('reached');
    } else if (stateIdx === activeIdx) {
      node.classList.add('active');
    }
  }

  // Highlight edges up to active state
  edges.forEach((edge, idx) => {
    if (idx < activeIdx) edge.classList.add('reached');
  });

  const captions = {
    ACCEPTED: 'Message accepted and persisted in SQLite',
    SUBMITTED: 'Provider accepted the message — awaiting delivery confirmation',
    SENT: 'Message is in transit to the destination',
    DELIVERED: '✓ Message successfully delivered — terminal state',
  };
  $('#smCaption').textContent = captions[currentStatus] || '';
}

// ═══════════════════
//  AUDIT TRAIL
// ═══════════════════
function showAuditTrail(trail) {
  const section = $('#auditSection');
  const timeline = $('#auditTimeline');

  if (!trail || trail.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  timeline.innerHTML = '';

  trail.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'audit-item';

    let dotClass = 'audit-accepted';
    const evt = item.event.toLowerCase();
    if (evt.includes('submit') || evt.includes('accepted')) dotClass = 'audit-submitted';
    if (evt.includes('deliver') || evt.includes('sent')) dotClass = 'audit-delivered';
    if (evt.includes('fail')) dotClass = 'audit-failed';
    if (evt.includes('failover')) dotClass = 'audit-failover';

    let transition = '';
    if (item.from_status || item.to_status) {
      transition = `<div class="audit-transition">${item.from_status || '—'} → ${item.to_status || '—'}</div>`;
    }

    div.innerHTML = `
      <div class="audit-dot ${dotClass}"></div>
      <div class="audit-content">
        <div class="audit-event">${escapeHtml(item.event)}</div>
        ${transition}
        <div class="audit-time">${item.created_at || ''}</div>
      </div>
    `;
    timeline.appendChild(div);
  });
}

// ═══════════════════
//  ATTEMPTS
// ═══════════════════
function showAttempts(attempts) {
  const section = $('#attemptsSection');
  const list = $('#attemptsList');

  if (!attempts || attempts.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  attempts.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'attempt-card';
    card.innerHTML = `
      <div>
        <span class="attempt-provider">${escapeHtml(a.provider)}</span>
        <span style="color: var(--text-dim); margin-left: 8px; font-size: 0.78rem;">attempt #${a.attempt_number}</span>
      </div>
      <span class="attempt-status st-${a.status}">${a.status}</span>
    `;
    list.appendChild(card);
  });
}

// ═══════════════════
//  HMAC-SHA256
// ═══════════════════
async function hmacSHA256(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════
//  UTILS
// ═══════════════════
function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const loader = btn.querySelector('.btn-loader');
  if (text) text.hidden = loading;
  if (loader) loader.hidden = !loading;
  btn.disabled = loading;
}
