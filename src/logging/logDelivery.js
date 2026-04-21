'use strict';

/**
 * LUXXPOOL v0.8.2 — Log Delivery (WebSocket)
 *
 * Streams pool_events in real time to dashboard/monitoring clients over
 * WebSocket at /ws/events. This is intentionally separate from the existing
 * PoolWebSocketServer (which handles dashboard data channels and auth) so
 * log floods cannot impact the dashboard path.
 *
 * Public API:
 *   attach(httpServer)  — mounts a WS.Server on path /ws/events
 *   stop()              — closes the server and all clients
 *
 * Client protocol:
 *   On connect, server sends { type: 'registry', events: [...] }
 *   Heartbeat every 10s:   { type: 'heartbeat', ts, clients }
 *   Each event:            { type: 'event', payload }
 *
 * Client-to-server control messages:
 *   { subscribe: ['share', 'block', ...] }   — filter by category
 *   { minSeverity: 'warn' }                   — filter by severity threshold
 */

const WebSocket = require('ws');
const { EVENTS } = require('./eventCodes');
const poolLogger = require('./poolLogger');

const SEVERITY_ORDER = { info: 0, warn: 1, error: 2, critical: 3 };

let wss = null;
let heartbeatTimer = null;

function _passesFilter(client, payload) {
  if (client._subscribe && client._subscribe.size && !client._subscribe.has(payload.category)) {
    return false;
  }
  if (client._minSeverity != null) {
    const sev = SEVERITY_ORDER[payload.severity] ?? 0;
    if (sev < client._minSeverity) return false;
  }
  return true;
}

function _send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) { /* swallow */ }
}

function _broadcast(payload) {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!_passesFilter(ws, payload)) continue;
    _send(ws, { type: 'event', payload });
  }
}

function _handleConnection(ws) {
  ws._subscribe = null;
  ws._minSeverity = null;

  _send(ws, { type: 'registry', events: Object.values(EVENTS) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (Array.isArray(msg.subscribe)) {
      ws._subscribe = new Set(msg.subscribe);
    }
    if (typeof msg.minSeverity === 'string' && msg.minSeverity in SEVERITY_ORDER) {
      ws._minSeverity = SEVERITY_ORDER[msg.minSeverity];
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
  ws.on('close', () => { /* ws.Server removes from wss.clients automatically */ });
}

function attach(httpServer) {
  if (wss) return;

  wss = new WebSocket.Server({ server: httpServer, path: '/ws/events' });
  wss.on('connection', _handleConnection);

  poolLogger.bus.on('pool_event', _broadcast);

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    const msg = { type: 'heartbeat', ts: Date.now(), clients: wss.clients.size };
    for (const ws of wss.clients) _send(ws, msg);
  }, 10_000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stop() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (wss) {
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch (_) {}
    }
    wss.close();
    wss = null;
  }
  poolLogger.bus.removeListener('pool_event', _broadcast);
}

module.exports = { attach, stop };
