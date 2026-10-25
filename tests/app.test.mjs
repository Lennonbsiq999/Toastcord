import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createAppServer, hashPassword, verifyPassword, normalizeName, sanitizeMessage } from '../server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toastcord-test-'));
let app;
let base;
let cookieA = '';
let cookieB = '';
let userA;
let serverId;
let customChannelId;

before(async () => {
  app = createAppServer({ dataDir, secureCookie: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (app?.server.listening) { app.server.closeIdleConnections(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  const json = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] || '' };
}

test('health endpoint and authentication', async () => {
  const page = await request('/');
  assert.equal(page.status, 200);
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'toastcord');
  const denied = await request('/api/bootstrap');
  assert.equal(denied.status, 401);
  const register = await request('/api/auth/register', { method:'POST', body:{ username:'ToastPilot', displayName:'Toast Pilot', password:'CorrectHorse!123' } });
  assert.equal(register.status, 201, JSON.stringify(register.json));
  cookieA = register.cookie;
  userA = register.json.user;
  assert.ok(cookieA.startsWith('toastcord_session='));
  assert.equal(register.json.user.username, 'ToastPilot');
  assert.equal('passwordHash' in register.json.user, false);
  const check = await request('/api/me', { cookie:cookieA });
  assert.equal(check.status, 200);
  assert.equal(check.json.user.id, userA.id);
});

test('default server, persistent message history and edits', async () => {
  const boot = await request('/api/bootstrap', { cookie:cookieA });
  assert.equal(boot.status, 200);
  assert.ok(boot.json.servers.some(s => s.id === 'toast-zone'));
  const general = boot.json.channels.find(c => c.id === 'ch-general');
  assert.ok(general);
  const sent = await request('/api/messages', { method:'POST', cookie:cookieA, body:{ channelId:general.id, text:'Diese Nachricht muss nach dem Neuladen bleiben.' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const messageId = sent.json.message.id;
  const history = await request(`/api/messages?channelId=${encodeURIComponent(general.id)}`, { cookie:cookieA });
  assert.equal(history.status, 200);
  assert.ok(history.json.messages.some(m => m.id === messageId));
  const edit = await request(`/api/messages/${encodeURIComponent(messageId)}`, { method:'PATCH', cookie:cookieA, body:{text:'Nachricht erfolgreich bearbeitet.'} });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.message.text, 'Nachricht erfolgreich bearbeitet.');
});

test('server creation, access control, invite join and members', async () => {
  const created = await request('/api/servers', { method:'POST', cookie:cookieA, body:{name:'Test Community', description:'Integrationstest'} });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  serverId = created.json.server.id;
  const channel = await request(`/api/servers/${encodeURIComponent(serverId)}/channels`, { method:'POST', cookie:cookieA, body:{name:'general-chat',kind:'text'} });
  assert.equal(channel.status, 201, JSON.stringify(channel.json));
  customChannelId = channel.json.channel.id;
  const registerB = await request('/api/auth/register', { method:'POST', body:{ username:'SecondMember', password:'AnotherSecure!456' } });
  assert.equal(registerB.status, 201, JSON.stringify(registerB.json));
  cookieB = registerB.cookie;
  const deniedBeforeJoin = await request(`/api/messages?channelId=${encodeURIComponent(customChannelId)}`, { cookie:cookieB });
  assert.equal(deniedBeforeJoin.status, 403);
  const join = await request('/api/servers/join', { method:'POST', cookie:cookieB, body:{inviteCode:created.json.server.inviteCode} });
  assert.equal(join.status, 200, JSON.stringify(join.json));
  assert.equal(join.json.server.id, serverId);
  const send = await request('/api/messages', { method:'POST', cookie:cookieB, body:{channelId:customChannelId,text:'Hallo, ich bin beigetreten.'} });
  assert.equal(send.status, 201);
  const memberList = await request(`/api/members?serverId=${encodeURIComponent(serverId)}`, {cookie:cookieA});
  assert.equal(memberList.status, 200);
  assert.ok(memberList.json.members.some(m => m.userId === userA.id), JSON.stringify({userA,memberList:memberList.json}));
  assert.ok(memberList.json.members.some(m => m.userId === registerB.json.user.id));
});


test('direct messages are private and persist for both participants', async () => {
  const create = await request('/api/dm/threads', {method:'POST',cookie:cookieA,body:{username:'SecondMember'}});
  assert.equal(create.status,200,JSON.stringify(create.json));
  const thread=create.json.thread;
  assert.equal(thread.otherDisplayName,'SecondMember');
  const sent=await request('/api/dm/messages',{method:'POST',cookie:cookieA,body:{threadId:thread.id,text:'Private Nachricht nur für uns.'}});
  assert.equal(sent.status,201,JSON.stringify(sent.json));
  const history=await request(`/api/dm/messages?threadId=${encodeURIComponent(thread.id)}`,{cookie:cookieB});
  assert.equal(history.status,200);
  assert.ok(history.json.messages.some(m=>m.text==='Private Nachricht nur für uns.'));
  const outsider=await request(`/api/dm/messages?threadId=${encodeURIComponent(thread.id)}`,{cookie:(await request('/api/auth/register',{method:'POST',body:{username:'Outsider',password:'ThirdSecure!789'}})).cookie});
  assert.equal(outsider.status,403);
});

test('authenticated WebSocket voice presence joins and leaves', async () => {
  const port=app.server.address().port;
  const socket=net.createConnection({host:'127.0.0.1',port});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const key=randomBytes(16).toString('base64');
  socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookieA}\r\n\r\n`);
  let handshake='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('WebSocket handshake timeout')),2000);
    const onData=chunk=>{handshake+=chunk.toString('binary');const end=handshake.indexOf('\r\n\r\n');if(end>=0){clearTimeout(timer);socket.off('data',onData);assert.match(handshake.slice(0,end),/101 Switching Protocols/);resolve();}};
    socket.on('data',onData);socket.once('error',reject);
  });
  const sendFrame=(obj)=>{const payload=Buffer.from(JSON.stringify(obj));const mask=randomBytes(4);const frame=Buffer.alloc(2+4+payload.length);frame[0]=0x81;frame[1]=0x80|payload.length;mask.copy(frame,2);for(let i=0;i<payload.length;i++)frame[6+i]=payload[i]^mask[i%4];socket.write(frame);};
  const waitFor=async(fn)=>{for(let i=0;i<40;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out waiting for websocket state');};
  sendFrame({type:'join_voice',channelId:'ch-lobby'});
  await waitFor(()=>app.store.state.voiceSessions.some(v=>v.userId===userA.id&&v.channelId==='ch-lobby'));
  const participants=await request('/api/voice/participants?channelId=ch-lobby',{cookie:cookieA});
  assert.equal(participants.status,200);
  assert.ok(participants.json.participants.some(p=>p.userId===userA.id));
  sendFrame({type:'leave_voice',channelId:'ch-lobby'});
  await waitFor(()=>!app.store.state.voiceSessions.some(v=>v.userId===userA.id&&v.channelId==='ch-lobby'));
  const closed = new Promise(resolve => socket.once('close', resolve));
  const mask=randomBytes(4); const closeFrame=Buffer.from([0x88,0x80,mask[0],mask[1],mask[2],mask[3]]); socket.write(closeFrame);
  await Promise.race([closed,new Promise(resolve=>setTimeout(()=>{socket.destroy();resolve();},500))]);
});

test('voice config is authenticated and returns ICE configuration', async () => {
  assert.equal((await request('/api/voice/config')).status, 401);
  const response = await request('/api/voice/config', {cookie:cookieA});
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.iceServers));
  assert.ok(response.json.iceServers.some(s => String(s.urls).includes('stun:')));
});

test('saved sessions and messages survive server restart', async () => {
  app.server.closeIdleConnections(); app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  app = createAppServer({ dataDir, secureCookie: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const boot = await request('/api/bootstrap', {cookie:cookieA});
  assert.equal(boot.status, 200);
  const history = await request('/api/messages?channelId=ch-general', {cookie:cookieA});
  assert.equal(history.status, 200);
  assert.ok(history.json.messages.some(m => m.text === 'Nachricht erfolgreich bearbeitet.'));
});

test('password hashing and input normalization', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
  assert.equal(normalizeName('  Toast  Pilot\n'), 'Toast Pilot');
  assert.equal(sanitizeMessage('  hello\u0000 world  '), 'hello world');
});
