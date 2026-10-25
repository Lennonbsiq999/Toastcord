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
let userB;
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

function maskedWsFrame(data, opcode = 1) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

async function openWebSocket(cookie) {
  const socket = net.createConnection({host:'127.0.0.1',port:app.server.address().port});
  let buffer = Buffer.alloc(0), handshaken = false;
  const queued = [], waiters = [];
  let readyResolve, readyReject;
  const ready = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
  const deliver = msg => {
    const index = waiters.findIndex(w => w.predicate(msg));
    if (index >= 0) { const waiter=waiters.splice(index,1)[0]; clearTimeout(waiter.timer); waiter.resolve(msg); }
    else queued.push(msg);
  };
  const waitFor = (predicate, timeout = 2500) => {
    const index=queued.findIndex(predicate);
    if(index>=0)return Promise.resolve(queued.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const waiter={predicate,resolve,reject,timer:null};
      waiter.timer=setTimeout(()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);reject(new Error('Timed out waiting for WebSocket message'));},timeout);
      waiters.push(waiter);
    });
  };
  socket.on('error',err=>{if(!handshaken)readyReject(err);});
  socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(!handshaken) {
      const end=buffer.indexOf(Buffer.from('\r\n\r\n'));
      if(end<0)return;
      const head=buffer.subarray(0,end).toString('utf8');
      if(!head.includes('101 Switching Protocols')){readyReject(new Error('WebSocket handshake failed: '+head));socket.destroy();return;}
      buffer=buffer.subarray(end+4);handshaken=true;readyResolve();
    }
    while(buffer.length>=2) {
      const opcode=buffer[0]&0x0f, masked=!!(buffer[1]&0x80);
      let length=buffer[1]&0x7f, offset=2;
      if(length===126){if(buffer.length<4)break;length=buffer.readUInt16BE(2);offset=4;}
      else if(length===127){if(buffer.length<10)break;const n=buffer.readBigUInt64BE(2);if(n>1048576n){socket.destroy();return;}length=Number(n);offset=10;}
      let mask;
      if(masked){if(buffer.length<offset+4)break;mask=buffer.subarray(offset,offset+4);offset+=4;}
      if(buffer.length<offset+length)break;
      const payload=Buffer.from(buffer.subarray(offset,offset+length));buffer=buffer.subarray(offset+length);
      if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
      if(opcode===0x8){socket.end();continue;}
      if(opcode===0x9){socket.write(maskedWsFrame(payload,0xA));continue;}
      if(opcode===0x1){try{deliver(JSON.parse(payload.toString('utf8')));}catch{}}
    }
  });
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const key=randomBytes(16).toString('base64');
  socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:'+app.server.address().port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\nCookie: '+cookie+'\r\n\r\n');
  await ready;
  return {
    socket, waitFor,
    send: data => socket.write(maskedWsFrame(data)),
    close: async () => {
      if(socket.destroyed)return;
      const closed=new Promise(resolve=>socket.once('close',resolve));
      try{socket.write(maskedWsFrame(Buffer.alloc(0),0x8));}catch{}
      await Promise.race([closed,new Promise(resolve=>setTimeout(()=>{socket.destroy();resolve();},400))]);
    }
  };
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
  userB = registerB.json.user;
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


test('message reactions persist, toggle off, and reject unsupported emoji', async () => {
  const created = await request('/api/messages', {
    method:'POST', cookie:cookieA,
    body:{channelId:'ch-general',text:'Reaktionen im Toastcord-Test'}
  });
  assert.equal(created.status, 201);
  const id = created.json.message.id;

  const first = await request(`/api/messages/${encodeURIComponent(id)}/reactions`, {
    method:'POST', cookie:cookieA, body:{emoji:'🔥'}
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(first.json.message.reactions['🔥'].includes(userA.id));

  const member = await request('/api/me',{cookie:cookieB});
  assert.equal(member.status, 200);
  const second = await request(`/api/messages/${encodeURIComponent(id)}/reactions`, {
    method:'POST', cookie:cookieB, body:{emoji:'🔥'}
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.ok(second.json.message.reactions['🔥'].includes(userA.id));
  assert.ok(second.json.message.reactions['🔥'].includes(member.json.user.id));

  const removed = await request(`/api/messages/${encodeURIComponent(id)}/reactions`, {
    method:'POST', cookie:cookieA, body:{emoji:'🔥'}
  });
  assert.equal(removed.status, 200);
  assert.ok(!removed.json.message.reactions['🔥'].includes(userA.id));

  const invalid = await request(`/api/messages/${encodeURIComponent(id)}/reactions`, {
    method:'POST', cookie:cookieA, body:{emoji:'<script>'}
  });
  assert.equal(invalid.status, 400);
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

test('two clients receive live messages and voice join/leave events', async () => {
  const wsA=await openWebSocket(cookieA);
  const wsB=await openWebSocket(cookieB);
  try {
    await Promise.all([wsA.waitFor(m=>m.type==='connected'),wsB.waitFor(m=>m.type==='connected')]);

    const sent=await request('/api/messages',{method:'POST',cookie:cookieA,body:{channelId:'ch-general',text:'Live-Nachricht muss beim zweiten Client ankommen.'}});
    assert.equal(sent.status,201);
    const received=await wsB.waitFor(m=>m.type==='message_new'&&m.message?.id===sent.json.message.id);
    assert.equal(received.message.text,'Live-Nachricht muss beim zweiten Client ankommen.');

    const joinA=await request('/api/voice/join',{method:'POST',cookie:cookieA,body:{channelId:'ch-lobby'}});
    assert.equal(joinA.status,200,JSON.stringify(joinA.json));
    const stateAtB=await wsB.waitFor(m=>m.type==='voice_state'&&m.channelId==='ch-lobby'&&m.participants.some(p=>p.userId===userA.id));
    assert.ok(stateAtB.participants.some(p=>p.userId===userA.id));

    const joinB=await request('/api/voice/join',{method:'POST',cookie:cookieB,body:{channelId:'ch-lobby'}});
    assert.equal(joinB.status,200,JSON.stringify(joinB.json));
    const stateAtA=await wsA.waitFor(m=>m.type==='voice_state'&&m.channelId==='ch-lobby'&&m.participants.some(p=>p.userId===userA.id)&&m.participants.some(p=>p.userId===userB.id));
    assert.equal(stateAtA.participants.length,2);

    const leaveB=await request('/api/voice/leave',{method:'POST',cookie:cookieB,body:{channelId:'ch-lobby'}});
    assert.equal(leaveB.status,200);
    const leftAtA=await wsA.waitFor(m=>m.type==='voice_state'&&m.channelId==='ch-lobby'&&!m.participants.some(p=>p.userId===userB.id));
    assert.ok(leftAtA.participants.some(p=>p.userId===userA.id));

    assert.equal((await request('/api/voice/leave',{method:'POST',cookie:cookieA,body:{channelId:'ch-lobby'}})).status,200);
  } finally {
    await Promise.all([wsA.close(),wsB.close()]);
  }
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
