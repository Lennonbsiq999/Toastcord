import http from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'toastcord_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;
const MAX_BODY = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;
const REACTION_EMOJIS = new Set(['👍','❤️','😂','🔥','🎉','🍞','👀','🤔','💀','🚀']);

export function createDefaultState() {
  const createdAt = Date.now();
  return {
    version: 1,
    users: [],
    sessions: [],
    servers: [{ id: 'toast-zone', name: 'Toast Zone', ownerId: 'system', inviteCode: 'TOASTZONE', description: 'Dein Platz zum Quatschen, Zocken und Teilen.', createdAt }],
    channels: [
      { id: 'ch-general', serverId: 'toast-zone', name: 'general', kind: 'text', createdAt },
      { id: 'ch-announcements', serverId: 'toast-zone', name: 'ankündigungen', kind: 'text', createdAt },
      { id: 'ch-clips', serverId: 'toast-zone', name: 'clips-und-highlights', kind: 'text', createdAt },
      { id: 'ch-minecraft', serverId: 'toast-zone', name: 'minecraft', kind: 'text', createdAt },
      { id: 'ch-lobby', serverId: 'toast-zone', name: 'Lobby', kind: 'voice', createdAt }
    ],
    memberships: [],
    threads: [],
    messages: [],
    voiceSessions: [],
    invites: [],
    auditLog: []
  };
}

export function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').slice(0, 32);
}
export function sanitizeMessage(value) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_MESSAGE_LENGTH);
}
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(key).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  try {
    const [scheme, saltHex, keyHex] = String(encoded).split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function newId(prefix = '') { return prefix + randomBytes(12).toString('hex'); }
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const bit of raw.split(';')) {
    const i = bit.indexOf('=');
    if (i < 0) continue;
    if (bit.slice(0, i).trim() === name) return decodeURIComponent(bit.slice(i + 1).trim());
  }
  return '';
}
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extraHeaders
  });
  res.end(body);
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
function setCookie(res, token, secure) {
  const attrs = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearCookie(res, secure) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request ist zu groß.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Ungültiges JSON.'), { status: 400 }); }
}

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'toastcord.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [key, value] of Object.entries(createDefaultState())) if (!(key in this.state)) this.state[key] = value;
      } catch (err) {
        throw new Error(`Die Datendatei ist beschädigt (${this.file}): ${err.message}`);
      }
    } else {
      this.state = createDefaultState();
      this.flush();
    }
  }
  flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  update(fn) {
    const result = fn(this.state);
    this.flush();
    return result;
  }
  userById(id) { return this.state.users.find(u => u.id === id) || null; }
  safeUser(user) {
    if (!user) return null;
    return { id: user.id, username: user.username, displayName: user.displayName, status: user.status || 'online', avatarColor: user.avatarColor || '#e7a34a', createdAt: user.createdAt };
  }
  sessionUser(req) {
    const token = getCookie(req, COOKIE);
    if (!token) return null;
    const hashed = hashToken(token);
    const session = this.state.sessions.find(s => s.tokenHash === hashed && s.expiresAt > Date.now());
    if (!session) return null;
    return this.userById(session.userId);
  }
  userServers(userId) {
    const ids = new Set(this.state.memberships.filter(m => m.userId === userId).map(m => m.serverId));
    return this.state.servers.filter(s => ids.has(s.id)).map(s => ({ ...s, role: this.role(s.id, userId) }));
  }
  role(serverId, userId) {
    if (this.state.servers.find(s => s.id === serverId)?.ownerId === userId) return 'owner';
    return this.state.memberships.find(m => m.serverId === serverId && m.userId === userId)?.role || 'member';
  }
  isMember(serverId, userId) {
    return this.state.servers.some(s => s.id === serverId && s.ownerId === userId) || this.state.memberships.some(m => m.serverId === serverId && m.userId === userId);
  }
  joinServer(serverId, userId) {
    if (!this.state.memberships.some(m => m.serverId === serverId && m.userId === userId)) {
      this.state.memberships.push({ id: newId('mem_'), serverId, userId, role: this.state.servers.find(s => s.id === serverId)?.ownerId === userId ? 'owner' : 'member', joinedAt: Date.now() });
    }
  }
  safeMessage(message) { return { ...message, author: this.safeUser(this.userById(message.authorId)) }; }
  members(serverId) {
    const ids = new Set(this.state.memberships.filter(m => m.serverId === serverId).map(m => m.userId));
    const server = this.state.servers.find(s => s.id === serverId);
    if (server?.ownerId && server.ownerId !== 'system') ids.add(server.ownerId);
    for (const session of this.state.voiceSessions) if (session.serverId === serverId) ids.add(session.userId);
    return [...ids].map(id => {
      const u = this.userById(id);
      if (!u) return null;
      const membership = this.state.memberships.find(m => m.serverId === serverId && m.userId === id);
      const online = u.status !== 'invisible' && [...liveSockets].some(c => c.userId === id);
      const voice = this.state.voiceSessions.some(v => v.serverId === serverId && v.userId === id);
      return { ...this.safeUser(u), userId: id, role: membership?.role || (server?.ownerId === id ? 'owner' : 'member'), online, voice };
    }).filter(Boolean).sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  }
}

const liveSockets = new Set();
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.json':'application/json; charset=utf-8' };

function makeWsFrame(data) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length < 65536) {
    const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([head, body]);
}
function sendWs(client, message) {
  if (!client.closed && !client.socket.destroyed) {
    try { client.socket.write(makeWsFrame(message)); } catch { closeWs(client); }
  }
}
function broadcast(message, filter = () => true) {
  for (const client of liveSockets) if (filter(client)) sendWs(client, message);
}
function sendVoiceState(store, serverId, channelId) {
  const participants = store.state.voiceSessions.filter(s => s.channelId === channelId).map(s => ({ userId: s.userId, displayName: store.userById(s.userId)?.displayName || 'Mitglied', channelId: s.channelId }));
  broadcast({ type: 'voice_state', serverId, channelId, participants }, c => c.userId && store.isMember(serverId, c.userId));
}
function recordAdminAction(store, { serverId, actorId, action, targetId = '', details = '' }) {
  store.state.auditLog ||= [];
  store.state.auditLog.push({ id: newId('audit_'), serverId, actorId, action, targetId, details: String(details).slice(0, 240), createdAt: Date.now() });
  if (store.state.auditLog.length > 250) store.state.auditLog.splice(0, store.state.auditLog.length - 250);
  store.flush();
}
function closeWs(client) {
  if (!client || client.closed) return;
  client.closed = true;
  liveSockets.delete(client);
  for (const voice of client.joinedVoice || []) {
    const idx = client.store.state.voiceSessions.findIndex(s => s.userId === client.userId && s.channelId === voice && (!s.connectionId || s.connectionId === client.connectionId));
    if (idx >= 0) {
      const serverId = client.store.state.voiceSessions[idx].serverId;
      client.store.state.voiceSessions.splice(idx, 1);
      try { client.store.flush(); } catch (err) { console.error('Unable to persist voice leave', err); }
      sendVoiceState(client.store, serverId, voice);
    }
  }
  try { client.socket.end(Buffer.from([0x88, 0x00])); } catch {}
}
function handleWsText(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const store = client.store;
  if (msg.type === 'ping') { sendWs(client, { type: 'pong', at: Date.now() }); return; }
  if (msg.type === 'join_voice') {
    const channelId = String(msg.channelId || '');
    const channel = store.state.channels.find(c => c.id === channelId && c.kind === 'voice');
    if (!channel || !store.isMember(channel.serverId, client.userId)) { sendWs(client, { type: 'error', message: 'Du hast keinen Zugriff auf diesen Sprachkanal.' }); return; }
    const current = store.state.voiceSessions.findIndex(s => s.userId === client.userId && s.channelId === channelId);
    const row = { userId: client.userId, channelId, serverId: channel.serverId, connectionId: client.connectionId, joinedAt: Date.now() };
    if (current >= 0) store.state.voiceSessions[current] = row; else store.state.voiceSessions.push(row);
    client.joinedVoice = new Set([...(client.joinedVoice || []), channelId]);
    store.flush();
    sendVoiceState(store, channel.serverId, channelId);
    return;
  }
  if (msg.type === 'leave_voice') {
    const channelId = String(msg.channelId || '');
    const idx = store.state.voiceSessions.findIndex(s => s.userId === client.userId && s.channelId === channelId && (!s.connectionId || s.connectionId === client.connectionId));
    const serverId = idx >= 0 ? store.state.voiceSessions[idx].serverId : '';
    if (idx >= 0) { store.state.voiceSessions.splice(idx, 1); store.flush(); }
    client.joinedVoice?.delete(channelId);
    if (serverId) sendVoiceState(store, serverId, channelId);
    return;
  }
  if (msg.type === 'rtc_signal') {
    const channelId = String(msg.channelId || '');
    const targetUserId = String(msg.targetUserId || '');
    if (!store.state.voiceSessions.some(s => s.userId === client.userId && s.channelId === channelId)) return;
    if (!store.state.voiceSessions.some(s => s.userId === targetUserId && s.channelId === channelId)) return;
    broadcast({ type: 'rtc_signal', fromUserId: client.userId, channelId, signal: msg.signal }, c => c.userId === targetUserId && c.joinedVoice?.has(channelId));
    return;
  }
  if (msg.type === 'presence') {
    const status = ['online','idle','dnd','invisible'].includes(msg.status) ? msg.status : 'online';
    const user = store.userById(client.userId);
    if (user) { user.status = status; store.flush(); broadcast({ type: 'presence_update', user: store.safeUser(user) }); }
  }
}
function attachWebSocket(server, store) {
  server.on('upgrade', (req, socket) => {
    let upgradePath = ''; try { upgradePath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch {}
    if (upgradePath !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket' || !host) { socket.destroy(); return; }
    if (origin) {
      try {
        const o = new URL(origin);
        if (!['http:', 'https:'].includes(o.protocol) || o.host !== host) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      } catch { socket.destroy(); return; }
    }
    const fakeReq = { headers: req.headers };
    const token = getCookie(fakeReq, COOKIE);
    const session = store.state.sessions.find(s => token && s.tokenHash === hashToken(token) && s.expiresAt > Date.now());
    const user = session ? store.userById(session.userId) : null;
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, userId: user.id, connectionId: newId('ws_'), store, buffer: Buffer.alloc(0), closed: false, joinedVoice: new Set() };
    liveSockets.add(client);
    for (const v of store.state.voiceSessions.filter(v => v.userId === user.id)) client.joinedVoice.add(v.channelId);
    sendWs(client, { type: 'connected', user: store.safeUser(user) });
    socket.on('data', chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      while (client.buffer.length >= 2) {
        const b0 = client.buffer[0], b1 = client.buffer[1];
        const opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (client.buffer.length < 4) break; len = client.buffer.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (client.buffer.length < 10) break; const big = client.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_BODY)) { closeWs(client); return; } len = Number(big); off = 10; }
        if (len > MAX_BODY) { closeWs(client); return; }
        let mask;
        if (masked) { if (client.buffer.length < off + 4) break; mask = client.buffer.subarray(off, off + 4); off += 4; }
        if (client.buffer.length < off + len) break;
        let payload = Buffer.from(client.buffer.subarray(off, off + len));
        client.buffer = client.buffer.subarray(off + len);
        if (masked && mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 0x8) { closeWs(client); return; }
        if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (opcode === 0x1) handleWsText(client, payload.toString('utf8'));
      }
    });
    socket.on('close', () => closeWs(client));
    socket.on('error', () => closeWs(client));
  });
}

export function createAppServer(options = {}) {
  const dataDir = options.dataDir || process.env.TOASTCORD_DATA_DIR || path.join(ROOT, 'data');
  const store = new JsonStore(dataDir);
  if (store.state.voiceSessions.length) { store.state.voiceSessions = []; store.flush(); }
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  const authFailures = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true, service: 'toastcord', version: 2 }); return; }
      if (pathname.startsWith('/api/')) { // Routes below are no-store by design.
        if (pathname === '/api/me') {
          const user = store.sessionUser(req);
          sendJson(res, user ? 200 : 401, user ? { user: store.safeUser(user) } : { error: 'Bitte melde dich an.' }); return;
        }
        if (pathname.startsWith('/api/auth/')) {
          if (pathname === '/api/auth/register' && req.method === 'POST') {
            const body = await readBody(req);
            const username = normalizeName(body.username);
            const displayName = normalizeName(body.displayName || body.username);
            const password = String(body.password || '');
            if (username.length < 3 || username.length > 32 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) { sendError(res, 400, 'Der Benutzername muss 3 bis 32 Zeichen haben und darf Buchstaben, Zahlen, Punkt, _ und - enthalten.'); return; }
            if (password.length < 10 || password.length > 200) { sendError(res, 400, 'Das Passwort muss mindestens 10 Zeichen lang sein.'); return; }
            if (store.state.users.some(u => u.username.toLocaleLowerCase() === username.toLocaleLowerCase())) { sendError(res, 409, 'Dieser Benutzername ist bereits vergeben.'); return; }
            const user = { id: newId('usr_'), username, displayName: displayName.slice(0,32) || username, passwordHash: await hashPassword(password), status:'online', avatarColor:['#f4a261','#e76f51','#2a9d8f','#8b7cf6','#53b3cb'][store.state.users.length % 5], createdAt:Date.now() };
            const token = randomBytes(32).toString('base64url');
            store.update(state => { state.users.push(user); state.sessions.push({ tokenHash:hashToken(token),userId:user.id,expiresAt:Date.now()+SESSION_TTL,createdAt:Date.now() }); state.memberships.push({ id:newId('mem_'),serverId:'toast-zone',userId:user.id,role:'member',joinedAt:Date.now() }); });
            setCookie(res, token, secureCookie); sendJson(res, 201, { user:store.safeUser(user) }); return;
          }
          if (pathname === '/api/auth/login' && req.method === 'POST') {
            const ip = req.socket.remoteAddress || 'unknown';
            let bucket = authFailures.get(ip);
            if (!bucket || bucket.resetAt <= Date.now()) bucket = { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
            if (bucket.count >= 10) { authFailures.set(ip, bucket); sendError(res, 429, 'Zu viele Anmeldeversuche. Warte 15 Minuten und versuche es erneut.'); return; }
            bucket.count += 1; authFailures.set(ip, bucket);
            const body = await readBody(req); const username = normalizeName(body.username); const password = String(body.password || '');
            const user = store.state.users.find(u => u.username.toLocaleLowerCase() === username.toLocaleLowerCase());
            if (!user || !(await verifyPassword(password, user.passwordHash))) { sendError(res, 401, 'Benutzername oder Passwort ist falsch.'); return; }
            authFailures.delete(ip);
            const token = randomBytes(32).toString('base64url');
            store.update(state => { state.sessions = state.sessions.filter(s => s.expiresAt > Date.now() && s.userId !== user.id); state.sessions.push({ tokenHash:hashToken(token),userId:user.id,expiresAt:Date.now()+SESSION_TTL,createdAt:Date.now() }); });
            setCookie(res, token, secureCookie); sendJson(res, 200, { user:store.safeUser(user) }); return;
          }
          if (pathname === '/api/auth/logout' && req.method === 'POST') {
            const token = getCookie(req, COOKIE); store.update(state => { state.sessions = state.sessions.filter(s => s.tokenHash !== hashToken(token)); });
            clearCookie(res, secureCookie); sendJson(res, 200, { ok:true }); return;
          }
        }
        const user = store.sessionUser(req);
        if (!user) { sendError(res, 401, 'Deine Sitzung ist abgelaufen. Melde dich erneut an.'); return; }
        if (pathname === '/api/voice/config') {
          const turnUrls = String(process.env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
          const turnUsername = process.env.TURN_USERNAME || '';
          const turnCredential = process.env.TURN_CREDENTIAL || '';
          const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
          if (turnUrls.length && turnUsername && turnCredential) iceServers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
          sendJson(res, 200, { iceServers, turnConfigured: iceServers.length > 1 }); return;
        }
        if (pathname === '/api/bootstrap' && req.method === 'GET') {
          const servers = store.userServers(user.id);
          const serverIds = new Set(servers.map(s => s.id));
          const channels = store.state.channels.filter(c => serverIds.has(c.serverId));
          const threads = store.state.threads.filter(t => t.participants.includes(user.id)).map(t => { const otherUserId = t.participants.find(id => id !== user.id) || user.id; return { ...t, otherUserId, otherDisplayName:store.safeUser(store.userById(otherUserId))?.displayName || 'Mitglied' }; });
          sendJson(res, 200, { me:store.safeUser(user), servers, channels, threads, members:servers.flatMap(s => store.members(s.id).map(m => ({...m,serverId:s.id}))), voiceSessions:store.state.voiceSessions }); return;
        }
        if (pathname === '/api/admin/overview' && req.method === 'GET') {
          const serverId = url.searchParams.get('serverId') || '';
          const server = store.state.servers.find(s => s.id === serverId);
          const role = store.role(serverId, user.id);
          if (!server || !store.isMember(serverId, user.id) || !['owner','admin'].includes(role)) { sendError(res, 403, 'Das Admin-Panel ist nur für Server-Owner und Admins verfügbar.'); return; }
          const channels = store.state.channels.filter(c => c.serverId === serverId);
          const channelIds = new Set(channels.map(c => c.id));
          const members = store.members(serverId);
          const messages = store.state.messages.filter(m => m.channelId && channelIds.has(m.channelId) && !m.deleted).slice(-40).reverse().map(m => ({ ...store.safeMessage(m), channelName:channels.find(c => c.id === m.channelId)?.name || 'Kanal' }));
          const auditLog = (store.state.auditLog || []).filter(entry => entry.serverId === serverId).slice(-30).reverse().map(entry => ({
            ...entry,
            actor: store.safeUser(store.userById(entry.actorId)),
            target: store.safeUser(store.userById(entry.targetId))
          }));
          sendJson(res, 200, {
            server: { ...server, role },
            channels,
            members,
            messages,
            auditLog,
            stats: {
              members: members.length,
              online: members.filter(m => m.online).length,
              channels: channels.length,
              messages: store.state.messages.filter(m => m.channelId && channelIds.has(m.channelId) && !m.deleted).length,
              inVoice: store.state.voiceSessions.filter(v => v.serverId === serverId).length
            }
          }); return;
        }
        const adminServerMatch = pathname.match(/^\/api\/admin\/server\/([^/]+)$/);
        if (adminServerMatch && req.method === 'PATCH') {
          const serverId = adminServerMatch[1];
          const server = store.state.servers.find(s => s.id === serverId);
          if (!server || !store.isMember(serverId, user.id) || store.role(serverId, user.id) !== 'owner') { sendError(res, 403, 'Nur der Server-Owner kann die Servereinstellungen ändern.'); return; }
          const body = await readBody(req);
          const name = normalizeName(body.name);
          const description = normalizeName(body.description).slice(0,160);
          if (name.length < 2) { sendError(res, 400, 'Der Servername muss mindestens zwei Zeichen haben.'); return; }
          store.update(() => { server.name = name.slice(0,48); server.description = description; });
          recordAdminAction(store, { serverId, actorId:user.id, action:'server_updated', details:server.name });
          broadcast({ type:'server_update', serverId }, c => store.isMember(serverId, c.userId));
          sendJson(res, 200, { server:{ ...server, role:store.role(serverId,user.id) } }); return;
        }
        const adminRoleMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)\/role$/);
        if (adminRoleMatch && req.method === 'POST') {
          const body = await readBody(req);
          const serverId = String(body.serverId || '');
          const targetId = adminRoleMatch[1];
          const server = store.state.servers.find(s => s.id === serverId);
          const role = store.role(serverId,user.id);
          const targetMembership = store.state.memberships.find(m => m.serverId === serverId && m.userId === targetId);
          if (!server || !store.isMember(serverId,user.id) || !['owner','admin'].includes(role)) { sendError(res,403,'Keine Berechtigung für die Rollenverwaltung.'); return; }
          if (!targetMembership) { sendError(res,404,'Mitglied wurde nicht gefunden.'); return; }
          if (role !== 'owner') { sendError(res,403,'Nur der Owner darf Admin-Rollen vergeben oder entfernen.'); return; }
          if (targetId === server.ownerId || targetId === user.id) { sendError(res,400,'Die Owner-Rolle kann hier nicht verändert werden.'); return; }
          const newRole = String(body.role || 'member');
          if (!['member','admin'].includes(newRole)) { sendError(res,400,'Erlaubt sind nur member oder admin.'); return; }
          store.update(() => { targetMembership.role = newRole; });
          recordAdminAction(store,{serverId,actorId:user.id,action:newRole==='admin'?'member_promoted':'member_demoted',targetId,details:store.safeUser(store.userById(targetId))?.username || targetId});
          broadcast({type:'member_update',serverId},c=>store.isMember(serverId,c.userId));
          sendJson(res,200,{ok:true,role:newRole}); return;
        }
        const adminMemberMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)$/);
        if (adminMemberMatch && req.method === 'DELETE') {
          const serverId = url.searchParams.get('serverId') || '';
          const targetId = adminMemberMatch[1];
          const server = store.state.servers.find(s => s.id === serverId);
          const actorRole = store.role(serverId,user.id);
          const membership = store.state.memberships.find(m => m.serverId === serverId && m.userId === targetId);
          if (!server || !store.isMember(serverId,user.id) || !['owner','admin'].includes(actorRole)) { sendError(res,403,'Keine Berechtigung für diese Serververwaltung.'); return; }
          if (!membership) { sendError(res,404,'Mitglied wurde nicht gefunden.'); return; }
          const targetRole = store.role(serverId,targetId);
          if (targetId === user.id || targetId === server.ownerId || targetRole === 'owner' || (actorRole !== 'owner' && targetRole === 'admin')) { sendError(res,403,'Du darfst dieses Mitglied nicht entfernen.'); return; }
          const removedVoice = store.state.voiceSessions.filter(v => v.serverId === serverId && v.userId === targetId);
          store.update(state => {
            state.memberships = state.memberships.filter(m => !(m.serverId === serverId && m.userId === targetId));
            state.voiceSessions = state.voiceSessions.filter(v => !(v.serverId === serverId && v.userId === targetId));
          });
          recordAdminAction(store,{serverId,actorId:user.id,action:'member_kicked',targetId,details:store.safeUser(store.userById(targetId))?.username || targetId});
          for (const voice of removedVoice) sendVoiceState(store,serverId,voice.channelId);
          broadcast({type:'member_update',serverId},c=>store.isMember(serverId,c.userId));
          broadcast({type:'server_kicked',serverId,serverName:server.name},c=>c.userId===targetId);
          sendJson(res,200,{ok:true}); return;
        }
        const adminMessageMatch = pathname.match(/^\/api\/admin\/messages\/([^/]+)$/);
        if (adminMessageMatch && req.method === 'DELETE') {
          const serverId = url.searchParams.get('serverId') || '';
          const server = store.state.servers.find(s => s.id === serverId);
          const role = store.role(serverId,user.id);
          const message = store.state.messages.find(m => m.id === adminMessageMatch[1] && !m.deleted);
          const channel = message?.channelId ? store.state.channels.find(c => c.id === message.channelId) : null;
          if (!server || !store.isMember(serverId,user.id) || !['owner','admin'].includes(role)) { sendError(res,403,'Keine Berechtigung für die Moderation.'); return; }
          if (!message || !channel || channel.serverId !== serverId) { sendError(res,404,'Nachricht in diesem Server nicht gefunden.'); return; }
          store.update(() => { message.deleted = true; message.deletedAt = Date.now(); });
          recordAdminAction(store,{serverId,actorId:user.id,action:'message_deleted',targetId:message.authorId,details:'#'+channel.name+': '+message.text.slice(0,120)});
          broadcast({type:'message_delete',channelId:channel.id,messageId:message.id},c=>store.isMember(serverId,c.userId));
          sendJson(res,200,{ok:true}); return;
        }
        if (pathname === '/api/voice/join' && req.method === 'POST') {
          const body = await readBody(req);
          const channelId = String(body.channelId || '');
          const channel = store.state.channels.find(c => c.id === channelId && c.kind === 'voice');
          if (!channel || !store.isMember(channel.serverId,user.id)) { sendError(res,403,'Du hast keinen Zugriff auf diesen Sprachkanal.'); return; }
          const oldSessions = store.state.voiceSessions.filter(v => v.userId === user.id);
          store.update(state => {
            state.voiceSessions = state.voiceSessions.filter(v => v.userId !== user.id);
            state.voiceSessions.push({userId:user.id,channelId,serverId:channel.serverId,connectionId:null,joinedAt:Date.now()});
          });
          for (const old of oldSessions) if (old.channelId !== channelId) sendVoiceState(store,old.serverId,old.channelId);
          sendVoiceState(store,channel.serverId,channelId);
          broadcast({type:'member_update',serverId:channel.serverId},c=>store.isMember(channel.serverId,c.userId));
          sendJson(res,200,{ok:true,channelId,participants:store.state.voiceSessions.filter(v=>v.channelId===channelId).map(v=>({userId:v.userId,displayName:store.userById(v.userId)?.displayName||'Mitglied',channelId:v.channelId}))}); return;
        }
        if (pathname === '/api/voice/leave' && req.method === 'POST') {
          const body = await readBody(req);
          const channelId = String(body.channelId || '');
          const sessions = store.state.voiceSessions.filter(v => v.userId===user.id && v.channelId===channelId);
          store.update(state=>{state.voiceSessions=state.voiceSessions.filter(v=>!(v.userId===user.id && v.channelId===channelId));});
          for (const session of sessions) {
            sendVoiceState(store,session.serverId,session.channelId);
            broadcast({type:'member_update',serverId:session.serverId},c=>store.isMember(session.serverId,c.userId));
          }
          sendJson(res,200,{ok:true}); return;
        }
        if (pathname === '/api/servers' && req.method === 'POST') {
          const body = await readBody(req); const name = normalizeName(body.name);
          if (name.length < 2) { sendError(res, 400, 'Der Servername muss mindestens zwei Zeichen haben.'); return; }
          const server = { id:newId('srv_'), name:name.slice(0,48), ownerId:user.id, inviteCode:randomBytes(5).toString('hex').toUpperCase(), description:normalizeName(body.description).slice(0,160), createdAt:Date.now() };
          const general = {id:newId('ch_'),serverId:server.id,name:'general',kind:'text',createdAt:Date.now()};
          const voice = {id:newId('ch_'),serverId:server.id,name:'voice-lobby',kind:'voice',createdAt:Date.now()+1};
          store.update(state => { state.servers.push(server); state.channels.push(general,voice); state.memberships.push({id:newId('mem_'),serverId:server.id,userId:user.id,role:'owner',joinedAt:Date.now()}); });
          sendJson(res, 201, { server:{...server,role:'owner'},channels:[general,voice] }); broadcast({type:'member_update',serverId:server.id},c=>store.isMember(server.id,c.userId)); return;
        }
        if (pathname === '/api/servers/join' && req.method === 'POST') {
          const body = await readBody(req); const code = String(body.inviteCode || '').trim().toUpperCase();
          const server = store.state.servers.find(s => s.inviteCode === code);
          if (!server) { sendError(res, 404, 'Einladungscode wurde nicht gefunden.'); return; }
          store.joinServer(server.id, user.id); store.flush();
          sendJson(res, 200, {server:{...server,role:store.role(server.id,user.id)},channels:store.state.channels.filter(c=>c.serverId===server.id)});
          broadcast({type:'member_update',serverId:server.id},c=>store.isMember(server.id,c.userId)); return;
        }
        const channelRoute = pathname.match(/^\/api\/servers\/([^/]+)\/channels$/);
        if (channelRoute && req.method === 'POST') {
          const serverId = channelRoute[1];
          if (!store.isMember(serverId,user.id)) { sendError(res,403,'Du bist nicht Mitglied dieses Servers.'); return; }
          const role=store.role(serverId,user.id); if (!['owner','admin'].includes(role)) { sendError(res,403,'Nur Owner und Admins können Kanäle erstellen.'); return; }
          const body=await readBody(req); const name=normalizeName(body.name).toLocaleLowerCase().replace(/\s+/g,'-').replace(/[^\p{L}\p{N}_-]/gu,'').slice(0,40);
          const kind=body.kind==='voice'?'voice':'text'; if(name.length<1){sendError(res,400,'Bitte gib einen Kanalnamen ein.');return;}
          const channel={id:newId('ch_'),serverId,name,kind,createdAt:Date.now()}; store.update(state=>state.channels.push(channel));
          sendJson(res,201,{channel}); broadcast({type:'channel_update',serverId},c=>store.isMember(serverId,c.userId)); return;
        }
        if (pathname === '/api/messages' && req.method === 'GET') {
          const channelId = url.searchParams.get('channelId') || '';
          const channel = store.state.channels.find(c => c.id === channelId);
          if (!channel || !store.isMember(channel.serverId,user.id) || channel.kind !== 'text') { sendError(res,403,'Dieser Textkanal ist nicht verfügbar.'); return; }
          sendJson(res,200,{messages:store.state.messages.filter(m=>m.channelId===channelId&&!m.deleted).slice(-200).map(m=>store.safeMessage(m))}); return;
        }
        if (pathname === '/api/messages' && req.method === 'POST') {
          const body=await readBody(req); const channelId=String(body.channelId||''); const text=sanitizeMessage(body.text);
          const channel=store.state.channels.find(c=>c.id===channelId);
          if (!channel || channel.kind!=='text' || !store.isMember(channel.serverId,user.id)) { sendError(res,403,'Du kannst in diesem Kanal nicht schreiben.'); return; }
          if (!text) { sendError(res,400,'Nachricht darf nicht leer sein.'); return; }
          const message={id:newId('msg_'),channelId,authorId:user.id,text,createdAt:Date.now(),editedAt:null,deleted:false,reactions:{}};
          store.update(state=>state.messages.push(message)); const safe=store.safeMessage(message);
          broadcast({type:'message_new',channelId,message:safe},c=>store.isMember(channel.serverId,c.userId));
          sendJson(res,201,{message:safe}); return;
        }
        if (pathname === '/api/dm/threads' && req.method === 'POST') {
          const body = await readBody(req);
          const lookup = normalizeName(body.username || body.recipientId);
          const recipient = store.state.users.find(u => u.id === lookup || u.username.toLocaleLowerCase() === lookup.toLocaleLowerCase());
          if (!recipient) { sendError(res, 404, 'Benutzer nicht gefunden. Prüfe den Namen und versuche es erneut.'); return; }
          if (recipient.id === user.id) { sendError(res, 400, 'Du kannst dir selbst keine Direktnachricht schicken.'); return; }
          const myServers = new Set(store.userServers(user.id).map(s => s.id));
          const sharesServer = store.userServers(recipient.id).some(s => myServers.has(s.id));
          if (!sharesServer) { sendError(res, 403, 'Ihr braucht mindestens einen gemeinsamen Server für Direktnachrichten.'); return; }
          const participants = [user.id,recipient.id].sort();
          let thread = store.state.threads.find(t => t.participants.length === 2 && t.participants[0] === participants[0] && t.participants[1] === participants[1]);
          if (!thread) { thread = {id:newId('dm_'),participants,createdAt:Date.now()}; store.update(state => state.threads.push(thread)); }
          sendJson(res, 200, {thread:{...thread,otherUserId:recipient.id,otherDisplayName:recipient.displayName}}); return;
        }
        if (pathname === '/api/dm/messages' && req.method === 'GET') {
          const threadId = url.searchParams.get('threadId') || '';
          const thread = store.state.threads.find(t => t.id === threadId && t.participants.includes(user.id));
          if (!thread) { sendError(res, 403, 'Diese Direktnachricht ist nicht verfügbar.'); return; }
          sendJson(res, 200, {messages:store.state.messages.filter(m=>m.threadId===threadId&&!m.deleted).slice(-200).map(m=>store.safeMessage(m))}); return;
        }
        if (pathname === '/api/dm/messages' && req.method === 'POST') {
          const body = await readBody(req); const threadId = String(body.threadId || ''); const text = sanitizeMessage(body.text);
          const thread = store.state.threads.find(t => t.id === threadId && t.participants.includes(user.id));
          if (!thread) { sendError(res, 403, 'Diese Direktnachricht ist nicht verfügbar.'); return; }
          if (!text) { sendError(res, 400, 'Nachricht darf nicht leer sein.'); return; }
          const message = {id:newId('msg_'),threadId,authorId:user.id,text,createdAt:Date.now(),editedAt:null,deleted:false,reactions:{}};
          store.update(state => state.messages.push(message)); const safe = store.safeMessage(message);
          broadcast({type:'dm_message_new',threadId,message:safe},c=>thread.participants.includes(c.userId));
          sendJson(res,201,{message:safe}); return;
        }
        const reactionMatch = pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
        if (reactionMatch && req.method === 'POST') {
          const message = store.state.messages.find(m => m.id === reactionMatch[1] && !m.deleted);
          if (!message) { sendError(res, 404, 'Nachricht nicht gefunden.'); return; }
          const thread = message.threadId ? store.state.threads.find(t => t.id === message.threadId) : null;
          const channel = message.channelId ? store.state.channels.find(c => c.id === message.channelId) : null;
          if (message.threadId) {
            if (!thread || !thread.participants.includes(user.id)) { sendError(res, 403, 'Du hast keinen Zugriff auf diese Direktnachricht.'); return; }
          } else if (!channel || channel.kind !== 'text' || !store.isMember(channel.serverId, user.id)) {
            sendError(res, 403, 'Du kannst auf diese Nachricht nicht reagieren.'); return;
          }
          const body = await readBody(req);
          const emoji = String(body.emoji || '');
          if (!REACTION_EMOJIS.has(emoji)) { sendError(res, 400, 'Dieses Emoji ist nicht verfügbar.'); return; }
          store.update(() => {
            message.reactions ||= {};
            const users = new Set(Array.isArray(message.reactions[emoji]) ? message.reactions[emoji] : []);
            if (users.has(user.id)) users.delete(user.id); else users.add(user.id);
            if (users.size) message.reactions[emoji] = [...users];
            else delete message.reactions[emoji];
          });
          const safe = store.safeMessage(message);
          if (thread) broadcast({ type:'message_reaction', threadId:thread.id, message:safe }, c => thread.participants.includes(c.userId));
          else broadcast({ type:'message_reaction', channelId:channel.id, message:safe }, c => store.isMember(channel.serverId, c.userId));
          sendJson(res, 200, { message:safe }); return;
        }
        const messagesMatch=pathname.match(/^\/api\/messages\/([^/]+)$/);
        if (messagesMatch && req.method === 'PATCH') {
          const message=store.state.messages.find(m=>m.id===messagesMatch[1]);
          if(!message||message.authorId!==user.id){sendError(res,404,'Nachricht nicht gefunden.');return;}
          const body=await readBody(req); const text=sanitizeMessage(body.text); if(!text){sendError(res,400,'Nachricht darf nicht leer sein.');return;}
          store.update(state=>{message.text=text;message.editedAt=Date.now();}); const safe=store.safeMessage(message);
          if(message.threadId){const thread=store.state.threads.find(t=>t.id===message.threadId);broadcast({type:'message_update',threadId:message.threadId,message:safe},c=>!!thread?.participants.includes(c.userId));}
          else broadcast({type:'message_update',channelId:message.channelId,message:safe},c=>c.userId===user.id||store.isMember(store.state.channels.find(ch=>ch.id===message.channelId)?.serverId,c.userId));
          sendJson(res,200,{message:safe}); return;
        }
        if (messagesMatch && req.method === 'DELETE') {
          const message=store.state.messages.find(m=>m.id===messagesMatch[1]);
          if(!message||message.authorId!==user.id){sendError(res,404,'Nachricht nicht gefunden.');return;}
          store.update(state=>{message.deleted=true;message.deletedAt=Date.now();});
          if(message.threadId){const thread=store.state.threads.find(t=>t.id===message.threadId);broadcast({type:'message_delete',threadId:message.threadId,messageId:message.id},c=>!!thread?.participants.includes(c.userId));}
          else broadcast({type:'message_delete',channelId:message.channelId,messageId:message.id},c=>c.userId===user.id||store.isMember(store.state.channels.find(ch=>ch.id===message.channelId)?.serverId,c.userId));
          sendJson(res,200,{ok:true}); return;
        }
        if (pathname === '/api/members' && req.method === 'GET') {
          const serverId=url.searchParams.get('serverId')||''; if(!store.isMember(serverId,user.id)){sendError(res,403,'Du hast keinen Zugriff auf diese Mitgliederliste.');return;}
          sendJson(res,200,{members:store.members(serverId)}); return;
        }
        if (pathname === '/api/profile' && req.method === 'PATCH') {
          const body=await readBody(req); const displayName=normalizeName(body.displayName); if(displayName.length<2){sendError(res,400,'Der Anzeigename ist zu kurz.');return;}
          store.update(state=>{user.displayName=displayName; if(['online','idle','dnd','invisible'].includes(body.status))user.status=body.status;});
          broadcast({type:'profile_update',user:store.safeUser(user)}); sendJson(res,200,{user:store.safeUser(user)}); return;
        }
        if (pathname === '/api/invites' && req.method === 'POST') {
          const body=await readBody(req); const server=store.state.servers.find(s=>s.id===body.serverId);
          if(!server||!store.isMember(server.id,user.id)){sendError(res,403,'Server nicht verfügbar.');return;}
          sendJson(res,200,{code:server.inviteCode,url:`${url.origin}/?invite=${server.inviteCode}`}); return;
        }
        if (pathname === '/api/voice/participants' && req.method === 'GET') {
          const channelId=url.searchParams.get('channelId')||''; const channel=store.state.channels.find(c=>c.id===channelId&&c.kind==='voice');
          if(!channel||!store.isMember(channel.serverId,user.id)){sendError(res,403,'Sprachkanal ist nicht verfügbar.');return;}
          const participants=store.state.voiceSessions.filter(s=>s.channelId===channelId).map(s=>({userId:s.userId,displayName:store.userById(s.userId)?.displayName||'Mitglied',joinedAt:s.joinedAt}));
          sendJson(res,200,{participants});return;
        }
        sendError(res,404,'API-Endpunkt nicht gefunden.'); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(res,405,'Methode nicht erlaubt.'); return; }
      let filePath = pathname === '/' ? path.join(PUBLIC,'index.html') : path.resolve(PUBLIC, '.' + pathname);
      if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== path.join(PUBLIC,'index.html')) { sendError(res,403,'Verboten.'); return; }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { sendError(res,404,'Datei nicht gefunden.'); return; }
      const content=fs.readFileSync(filePath); res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'application/octet-stream','Content-Length':content.length,'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",'Cache-Control':path.extname(filePath)==='.html'?'no-store':'public, max-age=300'}); if(req.method==='HEAD')res.end();else res.end(content);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendError(res, err.status || 500, err.status ? err.message : 'Interner Serverfehler. Bitte prüfe die Serverlogs.');
      else res.destroy();
    }
  });
  attachWebSocket(server, store);
  return { server, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = createAppServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`Toastcord running on http://${host}:${port}`));
  const shutdown = () => { for (const client of [...liveSockets]) closeWs(client); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
