'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  me: null, servers: [], channels: [], members: [], messages: [], threads: [],
  mode: 'channel', activeThreadId: '', activeServerId: 'toast-zone', activeChannelId: 'ch-general',
  authMode: 'login', modal: '', modalData: {}, search: '', draft: '',
  ws: null, wsReconnect: 800, wsIntentionalClose: false, wsReady: false,
  voiceParticipants: {}, voiceChannelId: '', localStream: null, screenStream: null,
  peerConnections: new Map(), remoteStreams: new Map(), pendingIce: new Map(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], turnConfigured: false,
  muted: false, voiceNotice: '', focusMode: false, bookmarks: new Set(), notes: '', theme: 'toast',
  onlineIds: new Set(), messageSearch: '', reactionTargetMessageId: '',
  adminData: null, adminLoading: false, adminError: '', localMode: false,
};
let liveSyncTimer = null, liveMessageSyncBusy = false, liveVoiceSyncBusy = false, lastVoiceSyncAt = 0;
const REACTION_EMOJIS = ['👍','❤️','😂','🔥','🎉','🍞','👀','🤔','💀','🚀'];
let pendingSubmit = false, viewLoadSequence = 0, memberLoadSequence = 0, bootstrapLoadSequence = 0, voiceJoinSequence = 0;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function initials(value) { return [...String(value || 'T').trim()][0]?.toUpperCase() || 'T'; }
function fmtTime(value) { return new Date(value || Date.now()).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}); }
function fmtDate(value) { const date = new Date(value || Date.now()); const today = new Date(); return date.toDateString() === today.toDateString() ? 'HEUTE' : date.toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'}).toUpperCase(); }
function currentServer() { return state.servers.find(s => s.id === state.activeServerId) || state.servers[0] || null; }
function currentChannel() { return state.channels.find(c => c.id === state.activeChannelId && c.serverId === state.activeServerId) || state.channels.find(c => c.serverId === state.activeServerId && c.kind === 'text') || null; }
function avatar(user, small = false, online = false) {
  const display = user?.displayName || user?.username || 'Toast-Nutzer';
  return `<span class="avatar${small?' small':''}${online?' online':''}" style="background:${esc(user?.avatarColor || '#e7a34a')}">${esc(initials(display))}</span>`;
}
function toast(message, type = '') {
  const node = document.createElement('div'); node.className = `toast-note ${type}`; node.textContent = message;
  $('#toasts').append(node); setTimeout(() => node.remove(), 3900);
}
async function api(url, options = {}) {
  const init = { method: options.method || 'GET', credentials: 'same-origin', headers: { ...(options.body !== undefined ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}
function saved(key, fallback = '') {
  try { const v = localStorage.getItem(`toastcord:${state.me?.id || 'guest'}:${key}`); return v === null ? fallback : v; } catch { return fallback; }
}
function save(key, value) { try { localStorage.setItem(`toastcord:${state.me?.id || 'guest'}:${key}`, String(value)); } catch {} }
function loadLocalPrefs() {
  try { state.bookmarks = new Set(JSON.parse(saved('bookmarks','[]'))); } catch { state.bookmarks = new Set(); }
  state.notes = saved('notes','');
  state.focusMode = saved('focus','false') === 'true';
  const theme = saved('theme','toast');
  state.theme = ['toast','neon','ocean','ember'].includes(theme) ? theme : 'toast';
  document.documentElement.dataset.theme = state.theme;
}
function persistBookmarks() { save('bookmarks', JSON.stringify([...state.bookmarks])); }

function renderAuth() {
  const register = state.authMode === 'register';
  $('#app').innerHTML = `
    <main class="auth-layout">
      <section class="auth-hero">
        <div class="brand"><span class="toast-mark">T</span><div>Toastcord<small>COMMUNITY, NICER.</small></div></div>
        <div class="hero-copy"><div class="eyebrow">Dein digitaler Treffpunkt</div><h1>Weniger scrollen.<br><em>Mehr zusammen.</em></h1><p>Dein Platz für Gaming, Gespräche, Clips und die Leute, die das Ganze erst gut machen. Ohne Server-Chaos, mit einer ordentlichen Portion Toast.</p><div class="hero-tags"><span class="hero-tag">◈ Textkanäle</span><span class="hero-tag">◉ Sprachräume</span><span class="hero-tag">✦ Deine Community</span></div></div>
        <div class="auth-footer">Toastcord · Ein Community-Projekt, frisch getoastet.</div>
      </section>
      <section class="auth-card-wrap"><div class="auth-card">
        <h2>${register?'Erstell dein Konto.':'Willkommen zurück.'}</h2><p class="sub">${register?'Dein nächster Community-Spot ist nur ein paar Felder entfernt.':'Melde dich an und steig wieder ins Gespräch ein.'}</p>
        <div class="auth-switch"><button data-action="auth-mode" data-mode="login" class="${register?'':'active'}">Anmelden</button><button data-action="auth-mode" data-mode="register" class="${register?'active':''}">Konto erstellen</button></div>
        <form id="auth-form">
          <div class="field"><label for="auth-username">Benutzername</label><input id="auth-username" name="username" autocomplete="${register?'username':'username'}" minlength="3" maxlength="32" required placeholder="z. B. toastpilot" /><span class="hint">3 bis 32 Zeichen, nur Buchstaben, Zahlen, Punkt, _ und -.</span></div>
          ${register?'<div class="field"><label for="auth-display">Anzeigename</label><input id="auth-display" name="displayName" maxlength="32" autocomplete="nickname" placeholder="Wie sollen dich andere sehen?" /></div>':''}
          <div class="field"><label for="auth-password">Passwort</label><input id="auth-password" name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?'10':'1'}" maxlength="200" required placeholder="${register?'Mindestens 10 Zeichen':'Dein Passwort'}" /></div>
          ${register?'<div class="field"><label for="auth-password2">Passwort bestätigen</label><input id="auth-password2" name="password2" type="password" autocomplete="new-password" required minlength="10" placeholder="Noch einmal eingeben" /></div>':''}
          <div id="auth-error" class="auth-error" hidden></div>
          <button class="auth-submit" type="submit">${register?'Konto erstellen　→':'Anmelden　→'}</button>
        </form>
        <div class="auth-security"><span>✦</span><div><b>Dein Konto, deine Leute.</b><br>Passwörter werden nicht im Klartext gespeichert. Deine Daten liegen auf dem Server, den du betreibst.</div></div>
      </div></section>
    </main>`;
}
function renderServerRail() {
  return `<aside class="server-rail">
    <button class="rail-logo" title="Toastcord" data-action="home">T</button><div class="rail-divider"></div>
    ${state.servers.map(s=>`<button class="server-icon ${s.id===state.activeServerId?'active':''}" data-action="server" data-id="${esc(s.id)}" title="${esc(s.name)}">${esc(initials(s.name))}</button>`).join('')}
    <button class="rail-add" data-action="modal" data-modal="create-server" title="Server erstellen">+</button>
    <button class="server-icon" data-action="modal" data-modal="join-server" title="Server beitreten">↗</button>
    <div class="rail-bottom"><button class="rail-mini" data-action="dm-home" title="Direktnachrichten">✉</button><button class="rail-mini" data-action="toastlab" title="ToastLab">✦</button><button class="rail-mini" data-action="profile" title="Profil">${esc(initials(state.me?.displayName))}</button></div>
  </aside>`;
}
function renderChannelPanel() {
  if(state.mode==='dm') {
    const active=state.threads.find(t=>t.id===state.activeThreadId);
    return `<aside class="channel-panel"><div class="channel-head"><strong>Direktnachrichten</strong><button class="icon-button" data-action="modal" data-modal="new-dm" title="Neue Nachricht">＋</button></div><div class="channel-scroll"><div class="channel-about"><div class="server-name">Deine Gespräche</div><p>Private Chats mit Leuten aus deinen gemeinsamen Servern.</p><button class="small-action" data-action="modal" data-modal="new-dm">+ Neue Nachricht</button></div><div class="group-label">Direktnachrichten</div>${state.threads.map(t=>`<div class="channel-row ${t.id===state.activeThreadId?'active':''}" data-action="dm-thread" data-id="${esc(t.id)}"><span class="ch-icon">@</span><span class="ch-name">${esc(t.otherDisplayName||'Mitglied')}</span></div>`).join('')||'<div class="members-empty">Noch keine Direktnachrichten. Starte ein Gespräch über „Neue Nachricht“.</div>'}</div><div class="profile-dock">${avatar(state.me,false,true)}<div class="profile-info"><b>${esc(state.me?.displayName)}</b><small>Direktnachrichten</small></div><div class="dock-btns"><button class="icon-button" data-action="profile" title="Profil & Status">⚙</button><button class="icon-button" data-action="logout" title="Abmelden">⇥</button></div></div></aside>`;
  }
  const server = currentServer();
  const channels = state.channels.filter(c=>c.serverId===server?.id);
  const text = channels.filter(c=>c.kind==='text'); const voice = channels.filter(c=>c.kind==='voice');
  const canManage = ['owner','admin'].includes(server?.role || 'member');
  return `<aside class="channel-panel">
    <div class="channel-head"><strong>${esc(server?.name || 'Toastcord')}</strong>${canManage?'<button class="icon-button admin-shortcut" data-action="admin-panel" title="Admin-Panel">⚙</button>':''}<button class="icon-button" data-action="server-menu" title="Server">⌄</button></div>
    <div class="channel-scroll">
      <div class="channel-about"><div class="server-name">${esc(server?.name || 'Community')}</div><p>${esc(server?.description || 'Dein Raum für Gespräche und gemeinsame Projekte.')}</p><div class="server-quick-actions"><button class="small-action" data-action="invite">Einladung teilen ↗</button><button class="small-action admin-launch" data-action="admin-panel">⚙ Admin-Panel öffnen</button></div><small class="build-version">Build 26.10.26-2 · Admin-Zugang</small></div>
      <div class="group-label">Textkanäle ${canManage?'<button data-action="modal" data-modal="create-channel" data-kind="text" title="Textkanal hinzufügen">+</button>':''}</div>
      ${text.map(c=>`<div class="channel-row ${c.id===state.activeChannelId?'active':''}" data-action="channel" data-id="${esc(c.id)}"><span class="ch-icon">#</span><span class="ch-name">${esc(c.name)}</span><span class="ch-more">···</span></div>`).join('') || '<div class="members-empty">Noch keine Textkanäle.</div>'}
      <div class="group-label" style="margin-top:15px">Sprachkanäle ${canManage?'<button data-action="modal" data-modal="create-channel" data-kind="voice" title="Sprachkanal hinzufügen">+</button>':''}</div>
      ${voice.map(c=>`<div class="channel-row ${c.id===state.activeChannelId?'active':''}" data-action="channel" data-id="${esc(c.id)}"><span class="ch-icon">◖))</span><span class="ch-name">${esc(c.name)}</span><span class="voice-count">${(state.voiceParticipants[c.id]||[]).length?`● ${(state.voiceParticipants[c.id]||[]).length}`:''}</span></div>${state.voiceChannelId===c.id?'<div class="voice-nested"><div class="channel-row" data-action="voice-settings"><span class="ch-icon">♬</span><span class="ch-name">Du bist verbunden</span></div></div>':''}`).join('') || '<div class="members-empty">Noch keine Sprachkanäle.</div>'}
    </div>
    ${state.voiceChannelId?`<div class="voice-banner"><div class="voice-status"><span>●</span> Sprachverbindung aktiv</div><small>${esc(channels.find(c=>c.id===state.voiceChannelId)?.name || 'Sprachkanal')}</small><button data-action="voice-toggle-mute">${state.muted?'Mikro an':'Mikro stumm'}</button> <button data-action="voice-leave">Trennen</button></div>`:''}
    <div class="profile-dock">${avatar(state.me,false,true)}<div class="profile-info"><b>${esc(state.me?.displayName)}</b><small>${esc(state.me?.status==='dnd'?'Nicht stören':state.me?.status==='idle'?'Abwesend':'Online')} · Toastcord</small></div><div class="dock-btns"><button class="icon-button" data-action="profile" title="Profil & Status">⚙</button><button class="icon-button" data-action="logout" title="Abmelden">⇥</button></div></div>
  </aside>`;
}
function renderMessage(message) {
  const author = message.author || (message.authorId===state.me?.id ? state.me : {displayName:'Mitglied',avatarColor:'#8b82f6'});
  const mine = message.authorId === state.me?.id;
  const bookmarked = state.bookmarks.has(message.id);
  const text = esc(message.text).replace(/\n/g,'<br>');
  const reactions = Object.entries(message.reactions || {}).filter(([emoji, users]) => REACTION_EMOJIS.includes(emoji) && Array.isArray(users) && users.length);
  const reactionChips = reactions.map(([emoji, users]) => `<button class="reaction-chip ${users.includes(state.me?.id)?'active':''}" data-action="react" data-id="${esc(message.id)}" data-emoji="${emoji}" title="${users.length} Reaktion(en)">${emoji}<span>${users.length}</span></button>`).join('');
  const reactionPicker = state.reactionTargetMessageId===message.id ? `<div class="reaction-picker" role="group" aria-label="Emoji-Reaktion auswählen">${REACTION_EMOJIS.map(emoji=>`<button data-action="choose-reaction" data-id="${esc(message.id)}" data-emoji="${emoji}" aria-label="Mit ${emoji} reagieren">${emoji}</button>`).join('')}</div>` : '';
  return `<article class="message" data-message-id="${esc(message.id)}">${avatar(author,true,false)}<div class="message-body"><div class="message-meta"><b>${esc(author.displayName)}</b><time>${fmtTime(message.createdAt)}</time></div><div class="message-text">${text}${message.editedAt?'<span class="edited">(bearbeitet)</span>':''}</div><div class="message-reactions">${reactionChips}<button class="reaction-add" data-action="add-reaction" data-id="${esc(message.id)}" title="Reaktion hinzufügen" aria-label="Reaktion hinzufügen">＋</button></div>${reactionPicker}</div><div class="message-actions"><button data-action="bookmark" data-id="${esc(message.id)}" title="${bookmarked?'Lesezeichen entfernen':'Merken'}">${bookmarked?'★':'☆'}</button>${mine?`<button data-action="edit-message" data-id="${esc(message.id)}" title="Bearbeiten">✎</button><button data-action="delete-message" data-id="${esc(message.id)}" title="Löschen">×</button>`:''}</div></article>`;
}
function renderDirectMessageChat() {
  const thread=state.threads.find(t=>t.id===state.activeThreadId);
  const messages=state.messages.filter(m=>!state.messageSearch||m.text.toLocaleLowerCase().includes(state.messageSearch.toLocaleLowerCase()));
  let lastDate='';
  const rendered=messages.map(m=>{const date=fmtDate(m.createdAt);const divider=date!==lastDate?`<div class="day-divider">${date}</div>`:'';lastDate=date;return divider+renderMessage(m);}).join('');
  const name=thread?.otherDisplayName||'Direktnachricht';
  return `<section class="chat-panel"><header class="topbar"><button class="icon-button mobile-only" data-action="toggle-nav" title="Chats öffnen">☰</button><div class="top-channel"><span class="hash">@</span><div style="min-width:0"><h2>${esc(name)}</h2><div class="topic">Private Direktnachricht · Nur ihr beide seht diesen Chat.</div></div></div><div class="top-actions"><label class="top-search"><span>⌕</span><input id="chat-search" value="${esc(state.messageSearch)}" placeholder="Chat durchsuchen" aria-label="Chat durchsuchen"><kbd> / </kbd></label><button class="icon-button" data-action="toastlab" title="ToastLab">✦</button></div></header><div class="chat-history" id="chat-history">${thread?`<div class="welcome-card"><div class="welcome-icon">@</div><h2>Du schreibst mit ${esc(name)}</h2><p>Private Nachrichten sind nur für die Teilnehmenden dieses Chats verfügbar.</p></div>${rendered||'<div class="empty-chat"><div><div class="empty-icon">✦</div><b>Das Gespräch startet hier.</b><p>Die erste Nachricht ist dran.</p></div></div>'}`:'<div class="empty-chat"><div><div class="empty-icon">@</div><b>Keine Direktnachricht ausgewählt.</b><p>Erstelle einen privaten Chat und starte ein Gespräch.</p><button class="small-action" data-action="modal" data-modal="new-dm">Neue Nachricht</button></div></div>'}</div><div class="composer-wrap"><div class="typing-hint">Nachricht an <b>${esc(name)}</b></div><form class="composer" id="composer-form"><button type="button" class="composer-tool" data-action="emoji" title="Emoji hinzufügen">☺</button><textarea id="composer-input" rows="1" maxlength="2000" ${thread?'':'disabled'} placeholder="${thread?'Schreib '+esc(name)+' eine Nachricht…':'Wähle oder erstelle zuerst einen Chat.'}">${esc(state.draft)}</textarea><button type="button" class="composer-tool" data-action="toastlab" title="Formatierung & Tools">✦</button><button class="send-btn" title="Senden" type="submit" ${thread?'':'disabled'}>↑</button></form><div class="composer-foot"><b>Enter</b> zum Senden · <b>Shift + Enter</b> für neue Zeile</div></div></section>`;
}
function renderChat() {
  if(state.mode==='dm')return renderDirectMessageChat();
  const channel=currentChannel();
  if (channel?.kind==='voice') return renderVoiceRoom(channel);
  const messages=state.messages.filter(m=>!state.messageSearch || m.text.toLocaleLowerCase().includes(state.messageSearch.toLocaleLowerCase()));
  let lastDate='';
  const rendered=messages.map(m=>{const date=fmtDate(m.createdAt);const divider=date!==lastDate?`<div class="day-divider">${date}</div>`:'';lastDate=date;return divider+renderMessage(m);}).join('');
  return `<section class="chat-panel"><header class="topbar"><button class="icon-button mobile-only" data-action="toggle-nav" title="Kanäle öffnen">☰</button><div class="top-channel"><span class="hash">#</span><div style="min-width:0"><h2>${esc(channel?.name||'general')}</h2><div class="topic">${esc(currentServer()?.name||'Toastcord')} · Hier beginnt das Gespräch.</div></div></div><div class="top-actions"><label class="top-search"><span>⌕</span><input id="chat-search" value="${esc(state.messageSearch)}" placeholder="Chat durchsuchen" aria-label="Chat durchsuchen"><kbd> / </kbd></label><button class="icon-button" data-action="toastlab" title="ToastLab">✦</button><button class="icon-button" data-action="members-toggle" title="Mitglieder">☷</button></div></header>
    <div class="chat-history" id="chat-history"><div class="welcome-card"><div class="welcome-icon">#</div><h2>Willkommen in #${esc(channel?.name||'general')}</h2><p>Das ist der Anfang des Kanals. Hier landen Pläne, Memes, Fragen und sämtliche genialen Ideen, die im Gruppenchat sonst untergehen.</p><p class="welcome-hint">🍞 Halte es freundlich. Der Toast ist für alle da.</p></div>${rendered||'<div class="empty-chat"><div><div class="empty-icon">✦</div><b>Noch ist es ruhig hier.</b><p>Schreib die erste Nachricht. Geschichte muss schließlich irgendwo anfangen.</p></div></div>'}</div>
    <div class="composer-wrap"><div class="typing-hint">Nachricht an <b>#${esc(channel?.name||'general')}</b></div><form class="composer" id="composer-form"><button type="button" class="composer-tool" data-action="emoji" title="Emoji hinzufügen">☺</button><textarea id="composer-input" rows="1" maxlength="2000" placeholder="Schreib etwas in #${esc(channel?.name||'general')}…">${esc(state.draft)}</textarea><button type="button" class="composer-tool" data-action="toastlab" title="Formatierung & Tools">✦</button><button class="send-btn" title="Senden" type="submit">↑</button></form><div class="composer-foot"><b>Enter</b> zum Senden · <b>Shift + Enter</b> für eine neue Zeile · <b>/help</b> für Befehle</div></div></section>`;
}
function renderVoiceRoom(channel) {
  const participants=state.voiceParticipants[channel.id]||[];
  const mePresent=state.voiceChannelId===channel.id;
  const tiles=participants.map(p=>{
    const user=p.userId===state.me?.id?state.me:{displayName:p.displayName,avatarColor:'#8b82f6'};
    const videoId=`remote-video-${p.userId}`;
    return `<div class="voice-tile" id="media-tile-${esc(p.userId)}">${avatar(user)}<strong>${esc(p.displayName||user.displayName)}${p.userId===state.me?.id?' (du)':''}</strong><small>${p.userId===state.me?.id?(!state.localStream?'Mikro aus':state.muted?'Mikro stumm':'Verbunden'):'Sprachverbindung'}</small></div>`;
  }).join('');
  return `<section class="chat-panel"><header class="topbar"><button class="icon-button mobile-only" data-action="toggle-nav">☰</button><div class="top-channel"><span class="hash">◖))</span><div><h2>${esc(channel.name)}</h2><div class="topic">Sprachkanal · Teilnehmer erscheinen auch vor der Audio-Verbindung.</div></div></div><div class="top-actions"><button class="icon-button" data-action="toastlab" title="ToastLab">✦</button></div></header><div class="chat-history"><div class="welcome-card"><div class="welcome-icon">◖))</div><h2>${esc(channel.name)}</h2><p>Mach dein Mikro an, hol die anderen dazu und redet los. Der Sprachraum bleibt offen, solange jemand verbunden ist.</p></div><div class="voice-stage"><div class="voice-stage-grid">${tiles||'<div class="empty-chat" style="grid-column:1/-1;min-height:160px"><div><div class="empty-icon">♫</div><b>Noch ist niemand im Sprachkanal.</b><p>Der erste Beitritt ist immer der awkward Moment. Du schaffst das.</p></div></div>'}</div><div class="voice-controls">${mePresent?`${state.localStream?`<button class="voice-control ${state.muted?'active':''}" data-action="voice-toggle-mute">${state.muted?'🎙 Mikro an':'🎙 Mikro stumm'}</button>`:`<button class="voice-control" data-action="voice-enable-mic">🎙 Mikrofon aktivieren</button>`}<button class="voice-control ${state.screenStream?'active':''}" data-action="voice-share">▣ ${state.screenStream?'Teilen beenden':'Bildschirm teilen'}</button><button class="voice-control danger" data-action="voice-leave">☎ Verbindung beenden</button>`:`<button class="primary-btn" style="width:auto" data-action="voice-join" data-id="${esc(channel.id)}">♫ Sprachkanal beitreten</button>`}</div><div class="voice-caption">${mePresent?(state.localStream?'Du bist verbunden. Wenn Audio nicht durchkommt, braucht dein Host gegebenenfalls TURN-Konfiguration.':esc(state.voiceNotice||'Du bist im Sprachkanal sichtbar, aber dein Mikrofon ist noch nicht verbunden.')):'Der Browser fragt beim Beitritt nach Mikrofon-Zugriff.'} ${state.turnConfigured?'TURN-Relay konfiguriert.':'TURN-Relay nicht konfiguriert.'}</div></div></div></section>`;
}
function renderMembers() {
  if(state.mode==='dm') {
    const thread=state.threads.find(t=>t.id===state.activeThreadId);
    const person=thread ? (state.members.find(m=>m.userId===thread.otherUserId) || {userId:thread.otherUserId,displayName:thread.otherDisplayName,online:false,avatarColor:'#8b82f6'}) : null;
    return `<aside class="members-panel"><div class="members-head"><strong>Gespräch</strong><span>${thread?'1:1':'—'}</span></div><div class="members-scroll">${person?`<div class="member-section"><div class="member-section-title">CHAT-PARTNER</div><div class="member-row">${avatar(person,true,person.online)}<div class="member-name"><b>${esc(person.displayName)}</b><small>${person.online?'Online':'Teilnehmer deiner Community'}</small></div><span class="member-status ${person.online?'online':''}"></span></div></div><p class="members-empty">Diese Direktnachricht ist privat. Nur du und ${esc(person.displayName)} könnt den Verlauf lesen.</p>`:'<div class="members-empty">Wähle eine Direktnachricht aus oder starte ein neues Gespräch.</div>'}</div></aside>`;
  }
  const server=currentServer();
  const members=state.members.filter(m=>m.serverId===server?.id);
  const online=members.filter(m=>m.online || m.userId===state.me?.id);
  const offline=members.filter(m=>!m.online && m.userId!==state.me?.id);
  const group=(label,rows,onlineFlag)=>`<div class="member-section"><div class="member-section-title">${label} · ${rows.length}</div>${rows.map(m=>`<div class="member-row">${avatar(m,true,onlineFlag)}<div class="member-name"><b>${esc(m.displayName)}${m.userId===state.me?.id?' (du)':''}</b><small>${m.voice?'♫ Im Sprachkanal':m.role==='owner'?'Serverbesitzer':m.status==='dnd'?'Nicht stören':m.online?'Online':'Offline'}</small></div><span class="member-status ${m.voice?'voice':onlineFlag?'online':''}"></span></div>`).join('')||'<div class="members-empty">Niemand in dieser Gruppe.</div>'}</div>`;
  return `<aside class="members-panel"><div class="members-head"><strong>Mitglieder</strong><span>${members.length}</span></div><div class="members-scroll">${group('Online',online,true)}${offline.length?group('Offline',offline,false):''}<button class="secondary-btn" style="width:100%;margin-top:8px" data-action="invite">+ Leute einladen</button></div></aside>`;
}
function render() {
  const focused = document.activeElement?.id;
  const start = ['composer-input','chat-search','auth-username','auth-password'].includes(focused) ? document.activeElement.selectionStart : null;
  const end = ['composer-input','chat-search','auth-username','auth-password'].includes(focused) ? document.activeElement.selectionEnd : null;
  if (!state.me) { renderAuth(); return; }
  $('#app').innerHTML=`<main class="workspace ${state.modal==='nav-open'?'nav-open':''}">${renderServerRail()}${renderChannelPanel()}${renderChat()}${renderMembers()}</main>${renderModal()}`;
  attachRemoteMedia();
  if (focused) {
    const target=document.getElementById(focused);
    if (target) { target.focus({preventScroll:true}); if(start!==null && typeof target.setSelectionRange==='function')target.setSelectionRange(start,end); }
  }
  if (!state.focusMode) {
    const history=$('#chat-history'); if(history && !state.userScrolled) history.scrollTop=history.scrollHeight;
  }
}
function renderModal() {
  if (!state.modal || state.modal==='nav-open') return '';
  if (state.modal==='create-server') return modalShell('Server erstellen',`<p class="modal-copy">Gründe einen neuen Ort für deine Community. Du wirst automatisch Serverbesitzer.</p><form id="create-server-form"><div class="field"><label for="server-name">Servername</label><input id="server-name" name="name" required minlength="2" maxlength="48" placeholder="z. B. Toast Zone" /></div><div class="field"><label for="server-description">Beschreibung (optional)</label><input id="server-description" name="description" maxlength="160" placeholder="Worum geht es hier?" /></div><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Server erstellen</button></form>`);
  if (state.modal==='join-server') return modalShell('Server beitreten',`<p class="modal-copy">Gib einen Einladungscode ein, den dir jemand geschickt hat.</p><form id="join-server-form"><div class="field"><label for="invite-code">Einladungscode</label><input id="invite-code" name="inviteCode" required maxlength="60" placeholder="z. B. A1B2C3D4" /></div><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Beitreten</button></form>`);
  if (state.modal==='create-channel') return modalShell(state.modalData.kind==='voice'?'Sprachkanal erstellen':'Textkanal erstellen',`<p class="modal-copy">Ein klarer Name hilft beim Wiederfinden. Menschen lieben Ordner, nur mit mehr Streit.</p><form id="create-channel-form"><div class="field"><label for="channel-name">Kanalname</label><input id="channel-name" name="name" required maxlength="40" placeholder="z. B. minecraft" /></div><input type="hidden" name="kind" value="${esc(state.modalData.kind||'text')}" /><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Kanal erstellen</button></form>`);
  if (state.modal==='new-dm') return modalShell('Neue Direktnachricht',`<p class="modal-copy">Suche nach dem exakten Benutzernamen einer Person, mit der du einen gemeinsamen Server hast.</p><form id="new-dm-form"><div class="field"><label for="dm-username">Benutzername</label><input id="dm-username" name="username" required minlength="3" maxlength="32" placeholder="z. B. ToastPilot" /></div><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Chat öffnen</button></form>`);
  if (state.modal==='invite') return modalShell('Community einladen',`<p class="modal-copy">Teile diesen Code mit Leuten, die dem Server beitreten sollen.</p><div class="invite-code">${esc(state.modalData.code||currentServer()?.inviteCode||'TOASTZONE')}</div><div class="inline-modal-actions"><button class="secondary-btn" data-action="copy-invite">Code kopieren</button><button class="primary-btn" data-action="copy-invite-link">Link kopieren</button></div>`);
  if (state.modal==='profile') return modalShell('Dein Profil',`<form id="profile-form"><div class="field"><label for="profile-name">Anzeigename</label><input id="profile-name" name="displayName" required minlength="2" maxlength="32" value="${esc(state.me.displayName)}" /></div><div class="field"><label for="profile-status">Status</label><select id="profile-status" name="status"><option value="online" ${state.me.status==='online'?'selected':''}>Online</option><option value="idle" ${state.me.status==='idle'?'selected':''}>Abwesend</option><option value="dnd" ${state.me.status==='dnd'?'selected':''}>Nicht stören</option><option value="invisible" ${state.me.status==='invisible'?'selected':''}>Unsichtbar</option></select></div><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Änderungen speichern</button></form><div style="margin-top:12px"><button class="secondary-btn" data-action="logout" style="width:100%">Abmelden</button></div>`);
  if (state.modal==='edit-message') return modalShell('Nachricht bearbeiten',`<form id="edit-message-form"><div class="field"><label for="edit-text">Nachricht</label><textarea id="edit-text" name="text" required maxlength="2000" rows="5">${esc(state.modalData.message?.text||'')}</textarea></div><div id="modal-error" class="auth-error" hidden></div><button class="primary-btn" type="submit">Speichern</button></form>`);
  if (state.modal==='toastlab') return renderToastLab();
  if (state.modal==='admin-panel') return renderAdminPanel();
  return '';
}
function modalShell(title,body,wide=false) { return `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true"><header class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Schließen">×</button></header><div class="modal-body">${body}</div></section></div>`; }
function renderToastLab() {
  const bookmarked=state.messages.filter(m=>state.bookmarks.has(m.id));
  return modalShell('ToastLab · Kleine Werkzeuge, weniger Chaos',`<div class="system-banner">✦ 8 Werkzeuge an einem Ort: persönliche Notizen, gespeicherte Nachrichten, Befehle, Umfragen, Export und mehr.</div><div class="toastlab-grid">
    <div class="lab-card"><div class="lab-icon">✎</div><h3>Private Notizen</h3><p>Nur in diesem Browser gespeichert. Kein Server darf deine Notizen lesen.</p><textarea id="lab-notes" rows="4" placeholder="Ideen, Links, To-dos…">${esc(state.notes)}</textarea><button data-action="save-notes">Notizen speichern</button></div>
    <div class="lab-card"><div class="lab-icon">★</div><h3>Gespeicherte Nachrichten</h3><p>${bookmarked.length} Nachricht(en) gemerkt.</p>${bookmarked.slice(-5).map(m=>`<p>“${esc(m.text.slice(0,100))}”</p>`).join('')||'<p>Mit ☆ neben einer Nachricht legst du Lesezeichen an.</p>'}<button data-action="show-bookmarks">Lesezeichen ansehen</button></div>
    <div class="lab-card"><div class="lab-icon">⌘</div><h3>Chat-Befehle</h3><p><code>/help</code>, <code>/roll</code>, <code>/flip</code>, <code>/shrug</code> und <code>/poll Frage | Option A | Option B</code></p><button data-action="command-help">Befehle anzeigen</button></div>
    <div class="lab-card"><div class="lab-icon">⇩</div><h3>Chat exportieren</h3><p>Lade die Nachrichten aus diesem Kanal als Textdatei herunter.</p><button data-action="export-chat">.txt exportieren</button></div>
    <div class="lab-card"><div class="lab-icon">☾</div><h3>Fokusmodus</h3><p>Reduziere Ablenkungen und konzentriere dich auf den aktuellen Kanal.</p><button data-action="focus-mode">${state.focusMode?'Fokusmodus deaktivieren':'Fokusmodus aktivieren'}</button></div>
    <div class="lab-card"><div class="lab-icon">🎨</div><h3>Look &amp; Feel</h3><p>Vier Looks, lokal gespeichert. Nur dein Browser wird umgestylt.</p><div class="theme-choices">${[['toast','🍞 Toast'],['neon','⚡ Neon'],['ocean','🌊 Ocean'],['ember','🔥 Ember']].map(([key,label])=>`<button class="theme-choice ${state.theme===key?'active':''}" data-action="theme-preset" data-theme-choice="${key}" aria-pressed="${state.theme===key}">${label}</button>`).join('')}</div></div>
     <div class="lab-card"><div class="lab-icon">⌁</div><h3>Systemstatus</h3><p>Verbindung, Server und Audio-Konfiguration prüfen.</p><div id="lab-status">WebSocket: ${state.wsReady?'verbunden':'nicht verbunden'}<br>TURN: ${state.turnConfigured?'konfiguriert':'nicht konfiguriert'}</div><button data-action="check-status">Status aktualisieren</button></div>
    <div class="lab-card"><div class="lab-icon">☺</div><h3>Schnellantwort</h3><p>Füge eine kurze Standardantwort in den Chat ein.</p><button data-action="quick-reply" data-text="Bin gleich da!">Bin gleich da</button><button data-action="quick-reply" data-text="Klingt gut, bin dabei.">Bin dabei</button></div>
    <div class="lab-card"><div class="lab-icon">▤</div><h3>Umfrage vorbereiten</h3><p>Erzeuge eine Chat-Umfrage mit Optionen.</p><div class="field"><input id="poll-question" placeholder="Frage" /></div><div class="field"><input id="poll-options" placeholder="Optionen, durch Kommas getrennt" /></div><button data-action="make-poll">Umfrage in Chat einfügen</button></div>
  </div>`,true);
}

function renderAdminPanel() {
  if (state.adminLoading) return modalShell('Admin-Panel · '+(currentServer()?.name||'Server'), '<div class="admin-loading"><div class="loading-line"><span></span></div><p>Serverdaten werden geladen…</p></div>', true);
  if (state.adminError || !state.adminData) {
    const recovery = state.localMode
      ? '<div class="admin-recovery"><h3>Lokaler Admin-Zugang</h3><p>Dein aktuelles Konto hat noch keine Admin-Rechte. Auf einer lokalen Installation kannst du die Serververwaltung für diesen PC wiederherstellen.</p><button class="primary-btn" data-action="claim-local-owner">Lokalen Server als Owner übernehmen</button></div>'
      : '<p class="modal-copy">Melde dich mit dem Server-Owner-Konto an oder lass dich vom Owner zum Admin ernennen.</p>';
    return modalShell('Admin-Panel', '<div class="system-banner admin-error-banner">'+esc(state.adminError||'Noch keine Serverdaten geladen.')+'</div>'+recovery+'<button class="secondary-btn" data-action="admin-refresh" style="margin-top:12px">Erneut versuchen</button>', true);
  }
  const data=state.adminData, server=data.server, owner=server.role==='owner';
  const stat=(label,value,icon)=>'<div class="admin-stat"><span>'+icon+'</span><small>'+label+'</small><strong>'+value+'</strong></div>';
  const roleText=role=>role==='owner'?'Owner':role==='admin'?'Admin':'Mitglied';
  const memberRows=data.members.map(m=>{
    const self=m.userId===state.me?.id, isOwner=m.role==='owner';
    const roleControls=owner&&!self&&!isOwner
      ? '<button class="admin-mini-btn" data-action="admin-role" data-id="'+esc(m.userId)+'" data-role="'+(m.role==='admin'?'member':'admin')+'">'+(m.role==='admin'?'Admin entfernen':'Zum Admin machen')+'</button>'
      : '';
    const canKick=!self&&!isOwner&&(owner||m.role==='member');
    return '<div class="admin-member-row">'+avatar(m,true,m.online)+'<div class="admin-member-info"><b>'+esc(m.displayName)+(self?' (du)':'')+'</b><small>@'+esc(m.username||'user')+' · '+roleText(m.role)+' · '+(m.voice?'Im Sprachkanal':m.online?'Online':'Offline')+'</small></div><div class="admin-member-actions">'+roleControls+(canKick?'<button class="admin-mini-btn danger" data-action="admin-kick" data-id="'+esc(m.userId)+'">Entfernen</button>':'')+'</div></div>';
  }).join('') || '<p class="members-empty">Keine Mitglieder.</p>';
  const messageRows=data.messages.map(m=>'<div class="admin-message-row"><div><b>'+esc(m.author?.displayName||'Mitglied')+'</b><small>#'+esc(m.channelName||'Kanal')+' · '+fmtTime(m.createdAt)+'</small><p>'+esc(m.text.slice(0,180))+'</p></div><button class="admin-mini-btn danger" data-action="admin-delete-message" data-id="'+esc(m.id)+'">Löschen</button></div>').join('') || '<p class="members-empty">Noch keine Nachrichten zum Moderieren.</p>';
  const auditText={server_updated:'Servereinstellungen geändert',member_kicked:'Mitglied entfernt',member_promoted:'Admin ernannt',member_demoted:'Admin-Rechte entfernt',message_deleted:'Nachricht moderiert gelöscht'};
  const auditRows=data.auditLog.map(log=>'<div class="admin-audit-row"><span class="admin-audit-dot"></span><div><b>'+esc(auditText[log.action]||log.action)+'</b><small>'+(esc(log.actor?.displayName||'System'))+' · '+new Date(log.createdAt).toLocaleString('de-DE')+'</small>'+(log.details?'<p>'+esc(log.details)+'</p>':'')+'</div></div>').join('') || '<p class="members-empty">Noch keine Admin-Aktionen.</p>';
  const settings=owner?'<form id="admin-server-form" class="admin-settings-form"><div class="field"><label for="admin-server-name">Servername</label><input id="admin-server-name" name="name" minlength="2" maxlength="48" required value="'+esc(server.name)+'" /></div><div class="field"><label for="admin-server-description">Beschreibung</label><input id="admin-server-description" name="description" maxlength="160" value="'+esc(server.description||'')+'" /></div><button class="primary-btn" type="submit">Server speichern</button></form>':'<p class="modal-copy">Du bist Admin. Servereinstellungen und Admin-Rollen darf nur der Owner ändern.</p>';
  return modalShell('Admin-Panel · '+server.name,
    '<div class="admin-toolbar"><p>Serververwaltung, Moderation und Live-Status.</p><button class="secondary-btn" data-action="admin-refresh">↻ Aktualisieren</button></div>'+
    '<div class="admin-stats">'+stat('Mitglieder',data.stats.members,'♟')+stat('Online',data.stats.online,'●')+stat('Kanäle',data.stats.channels,'▤')+stat('Nachrichten',data.stats.messages,'✉')+stat('Im Voice',data.stats.inVoice,'♫')+'</div>'+
    '<div class="admin-columns"><section class="admin-section"><div class="admin-section-heading"><div><h3>Mitglieder &amp; Rollen</h3><p>Admin-Rechte können nur Owner vergeben.</p></div><span>'+data.members.length+'</span></div><div class="admin-member-list">'+memberRows+'</div></section>'+
    '<section class="admin-section"><div class="admin-section-heading"><div><h3>Servereinstellungen</h3><p>Einladungs-Code: <code>'+esc(server.inviteCode)+'</code></p></div></div>'+settings+'</section></div>'+
    '<section class="admin-section admin-wide-section"><div class="admin-section-heading"><div><h3>Nachrichten moderieren</h3><p>Die letzten Nachrichten aus diesem Server. Gelöschte Nachrichten sind nicht mehr sichtbar.</p></div><span>'+data.messages.length+'</span></div><div class="admin-message-list">'+messageRows+'</div></section>'+
    '<section class="admin-section admin-wide-section"><div class="admin-section-heading"><div><h3>Audit-Log</h3><p>Protokoll der letzten Admin-Aktionen.</p></div><span>'+data.auditLog.length+'</span></div><div class="admin-audit-list">'+auditRows+'</div></section>',true);
}
async function claimLocalOwner() {
  try {
    await api('/api/local/claim-owner', {method:'POST', body:{serverId:state.activeServerId}});
    const data=await api('/api/bootstrap');
    state.localMode=!!data.localMode; state.me=data.me; state.servers=data.servers||[]; state.channels=data.channels||[]; state.members=data.members||[]; state.threads=data.threads||[];
    state.adminData=null; state.adminError='';
    toast('Lokaler Admin-Zugang wiederhergestellt.','success');
    await loadAdminPanelData(); await refreshMembers();
  } catch(e) { state.adminError=e.message; state.adminLoading=false; render(); toast(e.message,'error'); }
}
async function loadAdminPanelData() {
  if (!state.me || !currentServer()) return;
  state.adminLoading=true; state.adminError=''; render();
  try { state.adminData=await api('/api/admin/overview?serverId='+encodeURIComponent(state.activeServerId)); }
  catch(e) { state.adminData=null; state.adminError=e.message; }
  finally { state.adminLoading=false; render(); }
}
async function openAdminPanel() {
  state.modal='admin-panel'; state.adminData=null; state.adminError=''; await loadAdminPanelData();
}
async function changeAdminRole(userId, role) {
  try { await api('/api/admin/members/'+encodeURIComponent(userId)+'/role',{method:'POST',body:{serverId:state.activeServerId,role}}); toast(role==='admin'?'Admin-Rechte vergeben.':'Admin-Rechte entfernt.','success'); await loadAdminPanelData(); await refreshMembers(); }
  catch(e) { toast(e.message,'error'); }
}
async function kickAdminMember(userId) {
  const member=state.adminData?.members.find(m=>m.userId===userId);
  if(!member||!confirm(member.displayName+' wirklich vom Server entfernen?')) return;
  try { await api('/api/admin/members/'+encodeURIComponent(userId)+'?serverId='+encodeURIComponent(state.activeServerId),{method:'DELETE'}); toast(member.displayName+' wurde vom Server entfernt.','success'); await loadAdminPanelData(); await refreshMembers(); }
  catch(e) { toast(e.message,'error'); }
}
async function adminDeleteMessage(id) {
  const message=state.adminData?.messages.find(m=>m.id===id);
  if(!message||!confirm('Diese Nachricht als Moderator löschen?')) return;
  try { await api('/api/admin/messages/'+encodeURIComponent(id)+'?serverId='+encodeURIComponent(state.activeServerId),{method:'DELETE'}); state.messages=state.messages.filter(m=>m.id!==id); toast('Nachricht moderiert gelöscht.','success'); await loadAdminPanelData(); render(); }
  catch(e) { toast(e.message,'error'); }
}
async function saveAdminServer(form) {
  const body=Object.fromEntries(new FormData(form).entries());
  try {
    const data=await api('/api/admin/server/'+encodeURIComponent(state.activeServerId),{method:'PATCH',body});
    state.servers=state.servers.map(s=>s.id===data.server.id?data.server:s);
    toast('Servereinstellungen gespeichert.','success');
    await loadAdminPanelData();
  } catch(e) { toast(e.message,'error'); }
}
function startLiveSync() {
  if(liveSyncTimer) clearInterval(liveSyncTimer);
  liveSyncTimer=setInterval(refreshLiveState,1200);
  refreshLiveState();
}
function sameMessages(a,b) {
  return a.length===b.length && a.every((m,i)=>m.id===b[i]?.id && m.text===b[i]?.text && m.editedAt===b[i]?.editedAt && JSON.stringify(m.reactions||{})===JSON.stringify(b[i]?.reactions||{}));
}
async function syncLiveMessages() {
  if(!state.me||liveMessageSyncBusy)return;
  const mode=state.mode;
  const thread=mode==='dm'?state.threads.find(t=>t.id===state.activeThreadId):null;
  const channel=mode==='channel'?currentChannel():null;
  if(mode==='dm'&&!thread)return;
  if(mode==='channel'&&channel?.kind!=='text')return;
  const id=mode==='dm'?thread.id:channel.id;
  liveMessageSyncBusy=true;
  try {
    const d=mode==='dm'
      ? await api('/api/dm/messages?threadId='+encodeURIComponent(id))
      : await api('/api/messages?channelId='+encodeURIComponent(id));
    // A slow response from the previous view must never overwrite the currently open chat.
    if(state.mode!==mode || (mode==='dm'?state.activeThreadId!==id:state.activeChannelId!==id))return;
    const next=d.messages||[];
    if(!sameMessages(state.messages,next)) {
      state.messages=next;
      if(!state.modal)render();
    }
  } catch(e) { console.debug('Live message sync failed; retrying',e); }
  finally {liveMessageSyncBusy=false;}
}
async function syncLiveVoicePresence() {
  if(!state.me||liveVoiceSyncBusy||Date.now()-lastVoiceSyncAt<2200)return;
  const serverId=currentServer()?.id;
  if(!serverId)return;
  const voiceChannels=state.channels.filter(c=>c.serverId===serverId&&c.kind==='voice');
  lastVoiceSyncAt=Date.now();
  liveVoiceSyncBusy=true;
  let shouldRender=false;
  try {
    const results=await Promise.all(voiceChannels.map(async channel=>{
      try { return {channelId:channel.id,participants:(await api('/api/voice/participants?channelId='+encodeURIComponent(channel.id))).participants||[]}; }
      catch(e) { console.debug('Voice presence sync failed for '+channel.id,e); return null; }
    }));
    // Ignore results if the user changed servers while the requests were in flight.
    if(state.activeServerId!==serverId)return;
    for(const result of results.filter(Boolean)) {
      const previous=state.voiceParticipants[result.channelId]||[];
      const next=result.participants;
      const before=previous.map(p=>p.userId).sort().join(',');
      const after=next.map(p=>p.userId).sort().join(',');
      if(before!==after || previous.some(p=>next.find(n=>n.userId===p.userId)?.displayName!==p.displayName)) {
        state.voiceParticipants[result.channelId]=next;
        if(state.voiceChannelId===result.channelId)syncVoicePeers(next);
        shouldRender=true;
      }
    }
    if(shouldRender&&!state.modal)render();
  } catch(e) { console.debug('Live voice sync failed; retrying',e); }
  finally {liveVoiceSyncBusy=false;}
}
function refreshLiveState() {
  if(!state.me)return;
  // A slow/failed message request no longer blocks independent voice presence updates.
  void syncLiveMessages();
  void syncLiveVoicePresence();
}

async function authenticate(form) {
  const values=Object.fromEntries(new FormData(form).entries());
  const err=$('#auth-error'); err.hidden=true; err.textContent='';
  try {
    if(state.authMode==='register' && values.password!==values.password2) throw new Error('Die beiden Passwörter stimmen nicht überein.');
    const data=await api(state.authMode==='register'?'/api/auth/register':'/api/auth/login',{method:'POST',body:{username:values.username,password:values.password,displayName:values.displayName}});
    state.me=data.user; await boot();
  } catch(e) { err.textContent=e.message; err.hidden=false; }
}
async function boot() {
  try {
    const data=await api('/api/bootstrap');
    state.me=data.me; state.localMode=!!data.localMode; state.servers=data.servers||[]; state.channels=data.channels||[]; state.members=data.members||[]; state.threads=data.threads||[]; state.voiceParticipants={}; for(const v of (data.voiceSessions||[])){(state.voiceParticipants[v.channelId] ||= []).push({userId:v.userId,displayName:state.members.find(m=>m.userId===v.userId)?.displayName||'Mitglied',channelId:v.channelId});}
    if(!state.servers.some(s=>s.id===state.activeServerId))state.activeServerId=state.servers[0]?.id||'toast-zone';
    const savedChannel=saved('active-channel','');
    if(savedChannel && state.channels.some(c=>c.id===savedChannel&&c.serverId===state.activeServerId))state.activeChannelId=savedChannel;
    else state.activeChannelId=state.channels.find(c=>c.serverId===state.activeServerId&&c.kind==='text')?.id||state.channels.find(c=>c.serverId===state.activeServerId)?.id||'';
    loadLocalPrefs();
    try { const conf=await api('/api/voice/config'); state.iceServers=conf.iceServers||state.iceServers; state.turnConfigured=!!conf.turnConfigured; } catch {}
    render(); await refreshView(); connectWs(); startLiveSync();
  } catch(e) { state.me=null; renderAuth(); toast(e.message,'error'); }
}
async function refreshView() {
  const requestId=++viewLoadSequence;
  const mode=state.mode, serverId=state.activeServerId, channelId=state.activeChannelId, threadId=state.activeThreadId;
  const stillCurrent=()=>requestId===viewLoadSequence && state.mode===mode &&
    (mode==='dm' ? state.activeThreadId===threadId : state.activeServerId===serverId && state.activeChannelId===channelId);
  if(mode==='dm') {
    const thread=state.threads.find(t=>t.id===threadId);
    if(thread) {
      try {
        const data=await api(`/api/dm/messages?threadId=${encodeURIComponent(thread.id)}`);
        if(!stillCurrent())return;
        state.messages=data.messages||[];
      } catch(e) {
        if(!stillCurrent())return;
        state.messages=[];
        toast(`Direktnachrichten konnten nicht geladen werden: ${e.message}`,'error');
      }
    } else {
      if(!stillCurrent())return;
      state.messages=[];
    }
  } else {
    const channel=state.channels.find(c=>c.id===channelId&&c.serverId===serverId);
    if(!channel)return;
    if(channel.kind==='text') {
      try {
        const data=await api(`/api/messages?channelId=${encodeURIComponent(channel.id)}`);
        if(!stillCurrent())return;
        state.messages=data.messages||[];
      } catch(e) {
        if(!stillCurrent())return;
        state.messages=[];
        toast(`Nachrichten konnten nicht geladen werden: ${e.message}`,'error');
      }
    } else {
      if(!stillCurrent())return;
      state.messages=[];
    }
  }
  if(!stillCurrent())return;
  await refreshMembers();
  if(!stillCurrent())return;
  render();
}
async function refreshMembers() {
  const server=currentServer(); if(!server)return;
  const serverId=server.id, requestId=++memberLoadSequence;
  try {
    const data=await api(`/api/members?serverId=${encodeURIComponent(serverId)}`);
    if(requestId!==memberLoadSequence || currentServer()?.id!==serverId)return;
    state.members=(data.members||[]).map(m=>({...m,serverId}));
  } catch(e) { console.warn('Member refresh failed',e); }
}
function connectWs() {
  if(!state.me || state.wsIntentionalClose) return;
  try {
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(`${proto}//${location.host}/ws`); state.ws=ws;
    ws.addEventListener('open',()=>{
      state.wsReady=true;state.wsReconnect=800;
      if(state.voiceChannelId) sendWs({type:'join_voice',channelId:state.voiceChannelId});
      if(!state.modal){refreshView().catch(()=>{});render();}
    });
    ws.addEventListener('message',event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}handleWs(msg);});
    ws.addEventListener('close',()=>{state.wsReady=false;if(state.ws===ws)state.ws=null;if(!state.modal)render();if(state.me&&!state.wsIntentionalClose){const delay=state.wsReconnect;state.wsReconnect=Math.min(12000,state.wsReconnect*1.6);setTimeout(connectWs,delay);}});
    ws.addEventListener('error',()=>{state.wsReady=false;});
  } catch(e) { console.warn('WebSocket unavailable',e); }
}
function sendWs(data) { if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify(data)); }
function handleWs(msg) {
  if(msg.type==='connected'){state.wsReady=true;if(!state.modal)render();return;}
  if(msg.type==='pong')return;
  if(msg.type==='dm_message_new'&&state.mode==='dm'&&msg.threadId===state.activeThreadId){if(!state.messages.some(m=>m.id===msg.message.id))state.messages.push(msg.message);if(!state.modal)render();return;}
  if(msg.type==='message_new'&&state.mode==='channel'&&msg.channelId===state.activeChannelId) {
    if(!state.messages.some(m=>m.id===msg.message.id))state.messages.push(msg.message);
    if(state.messages.length>200)state.messages=state.messages.slice(-200);
    if(!state.modal)render();return;
  }
  if(msg.type==='message_update') {
    const i=state.messages.findIndex(m=>m.id===msg.message.id);if(i>=0)state.messages[i]=msg.message;if(!state.modal)render();return;
  }
  if(msg.type==='message_reaction') {
    const relevant = msg.channelId ? state.mode==='channel' && state.activeChannelId===msg.channelId : state.mode==='dm' && state.activeThreadId===msg.threadId;
    if(relevant) { const i=state.messages.findIndex(m=>m.id===msg.message.id); if(i>=0){state.messages[i]=msg.message;if(!state.modal)render();} }
    return;
  }
  if(msg.type==='message_delete') {state.messages=state.messages.filter(m=>m.id!==msg.messageId);if(!state.modal)render();return;}
  if(msg.type==='member_update'||msg.type==='profile_update'||msg.type==='presence_update') {refreshMembers().then(()=>{if(!state.modal)render();});return;}
  if(msg.type==='channel_update'||msg.type==='server_update') {loadBootstrapSoft();return;}
  if(msg.type==='server_kicked') {
    state.servers=state.servers.filter(s=>s.id!==msg.serverId);state.channels=state.channels.filter(c=>c.serverId!==msg.serverId);
    if(state.activeServerId===msg.serverId){leaveVoice(false);state.activeServerId=state.servers[0]?.id||'toast-zone';state.activeChannelId=state.channels.find(c=>c.serverId===state.activeServerId&&c.kind==='text')?.id||'ch-general';state.mode='channel';state.modal='';refreshView().catch(()=>{});}
    toast('Du wurdest vom Server '+(msg.serverName||'')+' entfernt.','error');render();return;
  }
  if(msg.type==='voice_state') {
    state.voiceParticipants[msg.channelId]=msg.participants||[];
    if(state.voiceChannelId===msg.channelId) syncVoicePeers(msg.participants||[]);
    if(!state.modal)render();return;
  }
  if(msg.type==='rtc_signal') {handleRtcSignal(msg).catch(e=>console.debug('RTC signal',e));return;}
  if(msg.type==='error')toast(msg.message||'Live-Verbindungsfehler','error');
}
async function loadBootstrapSoft() {
  const requestId=++bootstrapLoadSequence;
  try {
    const d=await api('/api/bootstrap');
    if(requestId!==bootstrapLoadSequence||!state.me)return;
    const previousServerId=state.activeServerId;
    state.localMode=!!d.localMode;
    state.servers=d.servers||[];
    state.channels=d.channels||[];
    if(!state.servers.some(s=>s.id===state.activeServerId)) {
      state.activeServerId=state.servers[0]?.id||'';
      state.activeChannelId=state.channels.find(c=>c.serverId===state.activeServerId&&c.kind==='text')?.id||'';
      state.messages=[];
      if(previousServerId!==state.activeServerId)state.modal='';
    }
    await refreshMembers();
    if(!state.modal)render();
  } catch(e) { console.debug('Bootstrap refresh failed; retrying later',e); }
}
async function switchServer(id) {
  if(!state.servers.some(s=>s.id===id))return;
  if(!state.voiceChannelId)++voiceJoinSequence;
  state.mode='channel';state.activeServerId=id;
  const ch=state.channels.find(c=>c.serverId===id&&c.kind==='text')||state.channels.find(c=>c.serverId===id);
  state.activeChannelId=ch?.id||'';state.messageSearch='';state.userScrolled=false;state.draft='';state.messages=[];save('active-channel',state.activeChannelId);state.modal='';
  await refreshView();
}
async function switchChannel(id) {
  const channel=state.channels.find(c=>c.id===id&&c.serverId===state.activeServerId);if(!channel)return;
  if(!state.voiceChannelId)++voiceJoinSequence;
  state.mode='channel';state.activeChannelId=id;state.messageSearch='';state.userScrolled=false;state.draft='';state.messages=[];save('active-channel',id);state.modal='';state.modalData={};$('#app').classList.remove('nav-open');
  if(channel.kind==='text'){await refreshView();}
  else {
    render();
    try {
      const d=await api(`/api/voice/participants?channelId=${encodeURIComponent(id)}`);
      if(state.mode!=='channel'||state.activeServerId!==channel.serverId||state.activeChannelId!==id)return;
      state.voiceParticipants[id]=d.participants||[];
      render();
    } catch(e) { console.debug('Voice participant refresh failed',e); }
  }
}
async function sendMessage(raw) {
  let text=String(raw||'').trim();if(!text||pendingSubmit)return;
  if(state.mode==='dm') {
    const thread=state.threads.find(t=>t.id===state.activeThreadId);
    if(!thread){toast('Wähle zuerst eine Direktnachricht aus.','error');return;}
    const threadId=thread.id;
    pendingSubmit=true;
    try {
      const d=await api('/api/dm/messages',{method:'POST',body:{threadId,text}});
      if(state.mode==='dm'&&state.activeThreadId===threadId) {
        if(!state.messages.some(m=>m.id===d.message.id))state.messages.push(d.message);
        state.draft='';
        const input=$('#composer-input');if(input)input.value='';
        render();
      }
    } catch(e) {toast(e.message,'error');}
    finally {pendingSubmit=false;}
    return;
  }
  const channel=currentChannel();if(!channel||channel.kind!=='text')return;
  const channelId=channel.id, serverId=state.activeServerId;
  if(text==='/help')text='Verfügbare Befehle: /help, /roll, /flip, /shrug, /poll Frage | Option A | Option B';
  else if(text==='/roll')text=`🎲 Ergebnis: ${Math.floor(Math.random()*6)+1}`;
  else if(text==='/flip')text=`🪙 ${Math.random()<.5?'Kopf':'Zahl'}`;
  else if(text==='/shrug')text='¯\\_(ツ)_/¯';
  else if(text.startsWith('/poll ')) {const parts=text.slice(6).split('|').map(v=>v.trim()).filter(Boolean);if(parts.length<3){toast('Format: /poll Frage | Option A | Option B','error');return;}text=`📊 **${parts[0]}**\n${parts.slice(1).map((v,i)=>`${i+1}. ${v}`).join('\n')}\nStimme mit der Nummer im Chat ab.`;}
  pendingSubmit=true;
  try {
    const d=await api('/api/messages',{method:'POST',body:{channelId,text}});
    if(state.mode==='channel'&&state.activeServerId===serverId&&state.activeChannelId===channelId) {
      if(!state.messages.some(m=>m.id===d.message.id))state.messages.push(d.message);
      state.draft='';
      const input=$('#composer-input');if(input)input.value='';
      render();
    }
  } catch(e) {toast(e.message,'error');}
  finally {pendingSubmit=false;}
}
async function createServer(form) {
  const body=Object.fromEntries(new FormData(form).entries());try{const d=await api('/api/servers',{method:'POST',body});state.servers.push(d.server);state.channels.push(...d.channels);state.activeServerId=d.server.id;state.activeChannelId=d.channels.find(c=>c.kind==='text')?.id||d.channels[0]?.id;state.modal='';await refreshView();toast('Server erstellt. Die digitale Hausordnung bleibt dir erspart.','success');}catch(e){modalError(e.message);}
}
async function joinServer(form) {
  const body=Object.fromEntries(new FormData(form).entries());try{const d=await api('/api/servers/join',{method:'POST',body});if(!state.servers.some(s=>s.id===d.server.id))state.servers.push(d.server);state.channels=state.channels.filter(c=>c.serverId!==d.server.id).concat(d.channels);state.activeServerId=d.server.id;state.activeChannelId=d.channels.find(c=>c.kind==='text')?.id||d.channels[0]?.id;state.modal='';await refreshView();toast(`Du bist ${d.server.name} beigetreten.`,'success');}catch(e){modalError(e.message);}
}
async function createChannel(form) {
  const body=Object.fromEntries(new FormData(form).entries());try{const d=await api(`/api/servers/${encodeURIComponent(state.activeServerId)}/channels`,{method:'POST',body});state.channels.push(d.channel);state.modal='';await switchChannel(d.channel.id);toast('Kanal erstellt.','success');}catch(e){modalError(e.message);}
}
async function createDm(form) {
  const body=Object.fromEntries(new FormData(form).entries());try{const d=await api('/api/dm/threads',{method:'POST',body});const thread=d.thread;const idx=state.threads.findIndex(t=>t.id===thread.id);if(idx>=0)state.threads[idx]=thread;else state.threads.unshift(thread);state.activeThreadId=thread.id;state.mode='dm';state.modal='';state.messageSearch='';await refreshView();toast(`Direktnachricht mit ${thread.otherDisplayName} geöffnet.`,'success');}catch(e){modalError(e.message);}
}
function modalError(message){const el=$('#modal-error');if(el){el.textContent=message;el.hidden=false;}else toast(message,'error');}
async function inviteServer() {try{const d=await api('/api/invites',{method:'POST',body:{serverId:state.activeServerId}});state.modalData={code:d.code,url:d.url};state.modal='invite';render();}catch(e){toast(e.message,'error');}}
async function copyText(text) {try{await navigator.clipboard.writeText(text);toast('Kopiert.','success');}catch{const box=document.createElement('textarea');box.value=text;document.body.append(box);box.select();document.execCommand('copy');box.remove();toast('Kopiert.','success');}}
async function logout() {
  state.wsIntentionalClose=true;leaveVoice(false);try{state.ws?.close();}catch{};state.ws=null;state.wsReady=false;
  try{await api('/api/auth/logout',{method:'POST',body:{}});}catch{}
  state.me=null;state.servers=[];state.channels=[];state.members=[];state.messages=[];state.modal='';state.wsIntentionalClose=false;state.draft='';renderAuth();
}
async function saveProfile(form) {
  const body=Object.fromEntries(new FormData(form).entries());try{const d=await api('/api/profile',{method:'PATCH',body});state.me=d.user;state.modal='';render();toast('Profil aktualisiert.','success');sendWs({type:'presence',status:state.me.status});}catch(e){modalError(e.message);}
}
async function editMessage() {
  const msg=state.modalData.message; const text=$('#edit-text')?.value?.trim();if(!msg||!text)return;
  try{const d=await api(`/api/messages/${encodeURIComponent(msg.id)}`,{method:'PATCH',body:{text}});const i=state.messages.findIndex(m=>m.id===msg.id);if(i>=0)state.messages[i]=d.message;state.modal='';render();toast('Nachricht bearbeitet.','success');}catch(e){modalError(e.message);}
}
async function deleteMessage(id) {
  if(!confirm('Diese Nachricht wirklich löschen?'))return;
  try{await api(`/api/messages/${encodeURIComponent(id)}`,{method:'DELETE'});state.messages=state.messages.filter(m=>m.id!==id);render();}catch(e){toast(e.message,'error');}
}
function toggleBookmark(id) {
  if(state.bookmarks.has(id))state.bookmarks.delete(id);else state.bookmarks.add(id);persistBookmarks();render();
}
async function toggleReaction(id, emoji) {
  if(!REACTION_EMOJIS.includes(emoji))return;
  try {
    const d=await api(`/api/messages/${encodeURIComponent(id)}/reactions`,{method:'POST',body:{emoji}});
    const i=state.messages.findIndex(m=>m.id===id);if(i>=0)state.messages[i]=d.message;
    state.reactionTargetMessageId='';render();
  } catch(e) {toast(e.message,'error');}
}
function exportChat() {
  const channel=currentChannel();const content=[`Toastcord · ${currentServer()?.name||''} / ${channel?.name||''}`,`Export am ${new Date().toLocaleString('de-DE')}`,'',...state.messages.map(m=>`[${new Date(m.createdAt).toLocaleString('de-DE')}] ${m.author?.displayName||'Mitglied'}: ${m.text}`)].join('\n');
  const blob=new Blob([content],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`toastcord-${(channel?.name||'chat').replace(/[^a-z0-9_-]/gi,'-')}.txt`;a.click();URL.revokeObjectURL(a.href);toast('Chat exportiert.','success');
}

async function startVoice(channelId) {
  if(state.voiceChannelId===channelId)return;
  if(state.voiceChannelId)leaveVoice(true);
  const joinToken=++voiceJoinSequence;
  let mediaStream=null, serverJoined=false, microphoneNotice='';
  const localHost=['localhost','127.0.0.1','::1'].includes(location.hostname.toLowerCase());
  const canCapture=!!navigator.mediaDevices?.getUserMedia&&(window.isSecureContext||localHost);
  if(!canCapture) {
    microphoneNotice=!window.isSecureContext&&!localHost
      ? 'Mikrofon-Audio benötigt HTTPS. Du kannst im Sprachkanal sichtbar bleiben; für Ton muss der Server über eine HTTPS-Adresse geöffnet werden.'
      : 'Dieser Browser stellt keinen Mikrofonzugriff bereit. Du kannst trotzdem im Sprachkanal sichtbar bleiben.';
  } else {
    try {
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    } catch(e) {
      microphoneNotice=e.name==='NotAllowedError'
        ? 'Mikrofonzugriff wurde blockiert. Erlaube das Mikrofon in den Website-Berechtigungen und klicke auf „Mikrofon aktivieren“.'
        : `Mikrofon nicht verfügbar: ${e.message||e.name}`;
    }
  }
  if(joinToken!==voiceJoinSequence){mediaStream?.getTracks().forEach(t=>t.stop());return;}
  state.localStream=mediaStream;
  state.voiceChannelId=channelId;state.muted=!mediaStream;state.voiceNotice=microphoneNotice;
  const channel=state.channels.find(c=>c.id===channelId);if(channel)state.activeServerId=channel.serverId;state.activeChannelId=channelId;
  state.messages=[];render();
  try {
    await api('/api/voice/join',{method:'POST',body:{channelId}});
    serverJoined=true;
    if(joinToken!==voiceJoinSequence){await api('/api/voice/leave',{method:'POST',body:{channelId}}).catch(()=>{});mediaStream?.getTracks().forEach(t=>t.stop());return;}
    sendWs({type:'join_voice',channelId});
    if(!state.wsReady)toast('Sprachstatus läuft über den Server. Live-Audio wartet auf die Verbindung.');
    if(microphoneNotice)toast('Du bist im Sprachkanal sichtbar, aber ohne Mikrofon: '+microphoneNotice,'error');
    const d=await api(`/api/voice/participants?channelId=${encodeURIComponent(channelId)}`);
    if(joinToken!==voiceJoinSequence)return;
    state.voiceParticipants[channelId]=d.participants||[];
    syncVoicePeers(state.voiceParticipants[channelId]||[]);render();
  } catch(e) {
    if(joinToken!==voiceJoinSequence){mediaStream?.getTracks().forEach(t=>t.stop());return;}
    if(serverJoined)await api('/api/voice/leave',{method:'POST',body:{channelId}}).catch(()=>{});
    state.voiceParticipants[channelId]=(state.voiceParticipants[channelId]||[]).filter(p=>p.userId!==state.me?.id);
    for(const [key,entry] of [...state.peerConnections.entries()])if(key.startsWith(`${channelId}:`)){entry.pc.close();state.peerConnections.delete(key);state.pendingIce.delete(key);state.remoteStreams.delete(key.slice(channelId.length+1));}
    if(state.voiceChannelId===channelId)state.voiceChannelId='';
    if(state.localStream===mediaStream){mediaStream?.getTracks().forEach(t=>t.stop());state.localStream=null;}
    state.voiceNotice='';state.muted=false;
    toast(`Sprachkanal-Beitritt fehlgeschlagen: ${e.message}`,'error');render();
  }
}
async function enableVoiceMicrophone() {
  const channelId=state.voiceChannelId;
  if(!channelId)return;
  const localHost=['localhost','127.0.0.1','::1'].includes(location.hostname.toLowerCase());
  if(!navigator.mediaDevices?.getUserMedia||(!window.isSecureContext&&!localHost)) {
    state.voiceNotice='Mikrofon-Audio benötigt HTTPS. Öffne Toastcord über eine HTTPS-Adresse.';
    render();toast(state.voiceNotice,'error');return;
  }
  let stream;
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(state.voiceChannelId!==channelId){stream.getTracks().forEach(t=>t.stop());return;}
    state.localStream=stream;state.muted=false;state.voiceNotice='';
    for(const [key,entry] of state.peerConnections)if(key.startsWith(`${channelId}:`))for(const track of stream.getTracks())entry.pc.addTrack(track,stream);
    syncVoicePeers(state.voiceParticipants[channelId]||[]);
    render();toast('Mikrofon verbunden.','success');
  } catch(e) {
    stream?.getTracks().forEach(t=>t.stop());
    state.voiceNotice=e.name==='NotAllowedError'
      ? 'Mikrofonzugriff wurde blockiert. Erlaube ihn in den Browser-Einstellungen.'
      : `Mikrofon konnte nicht aktiviert werden: ${e.message||e.name}`;
    render();toast(state.voiceNotice,'error');
  }
}
function ensurePeer(userId,channelId) {
  const key=`${channelId}:${userId}`;let entry=state.peerConnections.get(key);if(entry)return entry;
  const pc=new RTCPeerConnection({iceServers:state.iceServers});
  entry={pc,polite:String(state.me.id).localeCompare(String(userId))>0,makingOffer:false,ignoreOffer:false,settingRemoteAnswerPending:false};state.peerConnections.set(key,entry);
  if(state.localStream)for(const track of state.localStream.getTracks())pc.addTrack(track,state.localStream);
  if(state.screenStream)for(const track of state.screenStream.getTracks())pc.addTrack(track,state.screenStream);
  pc.onicecandidate=event=>{if(event.candidate)sendWs({type:'rtc_signal',channelId,targetUserId:userId,signal:{candidate:event.candidate}});};
  pc.ontrack=event=>{
    let stream=state.remoteStreams.get(userId);if(!stream){stream=new MediaStream();state.remoteStreams.set(userId,stream);}
    if(!stream.getTracks().some(t=>t.id===event.track.id))stream.addTrack(event.track);
    event.track.onended=()=>{const s=state.remoteStreams.get(userId);if(s){s.removeTrack(event.track);render();}};
    render();
  };
  pc.onnegotiationneeded=async()=>{
    try{entry.makingOffer=true;await pc.setLocalDescription();sendWs({type:'rtc_signal',channelId,targetUserId:userId,signal:{description:pc.localDescription}});}catch(e){console.debug('Negotiation error',e);}finally{entry.makingOffer=false;}
  };
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState)){console.debug('Peer connection',pc.connectionState,userId);}};
  state.pendingIce.set(key,state.pendingIce.get(key)||[]);
  return entry;
}
function syncVoicePeers(participants) {
  if(!state.voiceChannelId)return;
  for(const p of participants)if(p.userId!==state.me?.id)ensurePeer(p.userId,state.voiceChannelId);
  const ids=new Set(participants.filter(p=>p.userId!==state.me?.id).map(p=>`${state.voiceChannelId}:${p.userId}`));
  for(const [key,entry] of [...state.peerConnections.entries()])if(key.startsWith(`${state.voiceChannelId}:`)&&!ids.has(key)){entry.pc.close();state.peerConnections.delete(key);state.remoteStreams.delete(key.slice(state.voiceChannelId.length+1));state.pendingIce.delete(key);}
}
async function handleRtcSignal(msg) {
  if(msg.channelId!==state.voiceChannelId || !state.me)return;
  const entry=ensurePeer(msg.fromUserId,msg.channelId);const pc=entry.pc;const signal=msg.signal||{};
  if(signal.description){
    const description=signal.description;
    const readyForOffer=!entry.makingOffer&&(pc.signalingState==='stable'||entry.settingRemoteAnswerPending);
    const collision=description.type==='offer'&&!readyForOffer;
    entry.ignoreOffer=!entry.polite&&collision;if(entry.ignoreOffer)return;
    entry.settingRemoteAnswerPending=description.type==='answer';
    try{if(collision&&entry.polite)await Promise.all([pc.setLocalDescription({type:'rollback'}),pc.setRemoteDescription(description)]);else await pc.setRemoteDescription(description);}finally{entry.settingRemoteAnswerPending=false;}
    if(description.type==='offer'){await pc.setLocalDescription(await pc.createAnswer());sendWs({type:'rtc_signal',channelId:msg.channelId,targetUserId:msg.fromUserId,signal:{description:pc.localDescription}});}
    const key=`${msg.channelId}:${msg.fromUserId}`;for(const candidate of state.pendingIce.get(key)||[])await pc.addIceCandidate(candidate).catch(()=>{});state.pendingIce.set(key,[]);
  } else if(signal.candidate) {
    if(pc.remoteDescription)await pc.addIceCandidate(signal.candidate).catch(e=>{if(!entry.ignoreOffer)console.debug('ICE candidate failed',e);});
    else {const key=`${msg.channelId}:${msg.fromUserId}`;const q=state.pendingIce.get(key)||[];q.push(signal.candidate);state.pendingIce.set(key,q);}
  }
}
function attachRemoteMedia() {
  for(const [userId,stream] of state.remoteStreams){
    const tile=$(`#media-tile-${CSS.escape(userId)}`);if(!tile)continue;
    let audio=$(`audio[data-audio-user="${CSS.escape(userId)}"]`);if(!audio){audio=document.createElement('audio');audio.dataset.audioUser=userId;audio.autoplay=true;audio.playsInline=true;audio.style.display='none';tile.append(audio);}if(audio.srcObject!==stream)audio.srcObject=stream;audio.play().catch(()=>{});
    if(stream.getVideoTracks().length){let video=$(`video[data-video-user="${CSS.escape(userId)}"]`);if(!video){video=document.createElement('video');video.dataset.videoUser=userId;video.autoplay=true;video.playsInline=true;video.muted=true;tile.prepend(video);}if(video.srcObject!==stream)video.srcObject=stream;}else $(`video[data-video-user="${CSS.escape(userId)}"]`)?.remove();
  }
  for(const audio of $$('audio[data-audio-user]'))if(!state.remoteStreams.has(audio.dataset.audioUser))audio.remove();
}
function toggleMute() {if(!state.localStream){toast('Verbinde zuerst dein Mikrofon.','error');return;}state.muted=!state.muted;state.localStream.getAudioTracks().forEach(t=>t.enabled=!state.muted);render();}
function stopScreenShare() {
  const stream=state.screenStream;if(!stream)return;state.screenStream=null;
  for(const track of stream.getTracks())track.stop();
  for(const {pc} of state.peerConnections.values())for(const sender of pc.getSenders())if(sender.track&&stream.getTracks().some(t=>t.id===sender.track.id))pc.removeTrack(sender);
  render();
}
async function toggleScreenShare() {
  if(state.screenStream){stopScreenShare();return;}
  if(!navigator.mediaDevices?.getDisplayMedia){toast('Bildschirmfreigabe wird von diesem Browser nicht unterstützt.','error');return;}
  try{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false});
    state.screenStream=stream;
    for(const {pc} of state.peerConnections.values())for(const track of stream.getTracks())pc.addTrack(track,stream);
    const videoTrack=stream.getVideoTracks()[0];if(videoTrack)videoTrack.onended=()=>{if(state.screenStream===stream)stopScreenShare();};
    render();
  } catch(e){toast(`Bildschirmfreigabe abgebrochen: ${e.message}`,'error');}
}
function leaveVoice(notify=true) {
  ++voiceJoinSequence;
  const channelId=state.voiceChannelId;if(channelId){if(notify)sendWs({type:'leave_voice',channelId});api('/api/voice/leave',{method:'POST',body:{channelId}}).catch(()=>{});}
  for(const track of state.localStream?.getTracks()||[])track.stop();for(const track of state.screenStream?.getTracks()||[])track.stop();
  for(const {pc} of state.peerConnections.values())pc.close();state.peerConnections.clear();state.remoteStreams.clear();state.pendingIce.clear();state.localStream=null;state.screenStream=null;state.voiceChannelId='';state.voiceNotice='';state.muted=false;
  if(channelId){state.voiceParticipants[channelId]=(state.voiceParticipants[channelId]||[]).filter(p=>p.userId!==state.me?.id);}render();
}

function handleClick(event) {
  if(event.target.matches('.workspace.nav-open')){state.modal='';render();return;}
  const el=event.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  if(action==='auth-mode'){state.authMode=el.dataset.mode;renderAuth();return;}
  if(action==='home'){switchServer('toast-zone');return;}
  if(action==='dm-home'){state.mode='dm';state.modal='';if(!state.activeThreadId&&state.threads.length)state.activeThreadId=state.threads[0].id;state.messages=[];refreshView();return;}
  if(action==='dm-thread'){state.mode='dm';state.activeThreadId=el.dataset.id;state.messageSearch='';state.draft='';state.modal='';refreshView();return;}
  if(action==='server'){switchServer(el.dataset.id);return;}
  if(action==='channel'){switchChannel(el.dataset.id);return;}
  if(action==='modal'){state.modal=el.dataset.modal;state.modalData={kind:el.dataset.kind||'text'};render();return;}
  if(action==='close-modal'){state.modal='';render();return;}
  if(action==='modal-backdrop'&&event.target===el){state.modal='';render();return;}
  if(action==='invite'){inviteServer();return;}
  if(action==='copy-invite'){copyText(state.modalData.code||currentServer()?.inviteCode||'TOASTZONE');return;}
  if(action==='copy-invite-link'){const code=state.modalData.code||currentServer()?.inviteCode||'TOASTZONE';copyText(`${location.origin}/?invite=${code}`);return;}
  if(action==='toastlab'){state.modal='toastlab';render();return;}
  if(action==='admin-panel'){openAdminPanel();return;}
  if(action==='claim-local-owner'){claimLocalOwner();return;}
  if(action==='admin-refresh'){loadAdminPanelData();return;}
  if(action==='admin-role'){changeAdminRole(el.dataset.id,el.dataset.role);return;}
  if(action==='admin-kick'){kickAdminMember(el.dataset.id);return;}
  if(action==='admin-delete-message'){adminDeleteMessage(el.dataset.id);return;}
  if(action==='profile'){state.modal='profile';render();return;}
  if(action==='logout'){logout();return;}
  if(action==='toggle-nav'){state.modal=state.modal==='nav-open'?'':'nav-open';render();return;}
  if(action==='members-toggle'){const panel=$('.members-panel');if(panel){panel.style.display=panel.style.display==='none'?'':'none';}return;}
  if(action==='emoji'){const input=$('#composer-input');if(input){const start=input.selectionStart;const value=input.value;input.value=value.slice(0,start)+' 🍞 '+value.slice(start);input.focus();input.selectionStart=input.selectionEnd=start+3;state.draft=input.value;}return;}
  if(action==='bookmark'){toggleBookmark(el.dataset.id);return;}
  if(action==='add-reaction'){state.reactionTargetMessageId=state.reactionTargetMessageId===el.dataset.id?'':el.dataset.id;render();return;}
  if(action==='react'||action==='choose-reaction'){toggleReaction(el.dataset.id,el.dataset.emoji);return;}
  if(action==='edit-message'){const message=state.messages.find(m=>m.id===el.dataset.id);state.modal='edit-message';state.modalData={message};render();return;}
  if(action==='delete-message'){deleteMessage(el.dataset.id);return;}
  if(action==='voice-join'){startVoice(el.dataset.id);return;}
  if(action==='voice-enable-mic'){enableVoiceMicrophone();return;}
  if(action==='voice-leave'){leaveVoice();return;}
  if(action==='voice-toggle-mute'){toggleMute();return;}
  if(action==='voice-share'){toggleScreenShare();return;}
  if(action==='save-notes'){state.notes=$('#lab-notes')?.value||'';save('notes',state.notes);toast('Notizen lokal gespeichert.','success');return;}
  if(action==='show-bookmarks'){const list=state.messages.filter(m=>state.bookmarks.has(m.id));toast(list.length?`${list.length} Lesezeichen im aktuellen Kanal.`:'Noch keine Lesezeichen.',list.length?'success':'');return;}
  if(action==='command-help'){const input=$('#composer-input');state.modal='';render();if(input){input.focus();state.draft='/help';input.value='/help';}toast('Befehle: /help, /roll, /flip, /shrug und /poll Frage | Option A | Option B');return;}
  if(action==='export-chat'){exportChat();return;}
  if(action==='focus-mode'){state.focusMode=!state.focusMode;save('focus',state.focusMode);render();toast(state.focusMode?'Fokusmodus aktiviert.':'Fokusmodus deaktiviert.');return;}
  if(action==='theme-preset'){const theme=el.dataset.themeChoice;if(['toast','neon','ocean','ember'].includes(theme)){state.theme=theme;save('theme',theme);document.documentElement.dataset.theme=theme;render();toast(({toast:'Toast-Theme aktiviert.',neon:'Neon-Theme aktiviert.',ocean:'Ocean-Theme aktiviert.',ember:'Ember-Theme aktiviert.'})[theme],'success');}return;}
  if(action==='check-status'){const status=$('#lab-status');if(status)status.innerHTML=`WebSocket: ${state.wsReady?'verbunden':'nicht verbunden'}<br>REST: erreichbar<br>TURN: ${state.turnConfigured?'konfiguriert':'nicht konfiguriert'}`;return;}
  if(action==='quick-reply'){const text=el.dataset.text||'';state.modal='';render();const input=$('#composer-input');if(input){input.value=text;state.draft=text;input.focus();}return;}
  if(action==='make-poll'){const q=$('#poll-question')?.value?.trim();const opts=($('#poll-options')?.value||'').split(',').map(v=>v.trim()).filter(Boolean);if(!q||opts.length<2){toast('Gib eine Frage und mindestens zwei Optionen ein.','error');return;}state.modal='';render();sendMessage(`📊 ${q}\n${opts.map((v,i)=>`${i+1}. ${v}`).join('\n')}\nAntworte mit deiner Nummer.`);return;}
  if(action==='server-menu'){const s=currentServer();toast(`Server: ${s?.name||'Toastcord'} · Code: ${s?.inviteCode||'TOASTZONE'}`);return;}
  if(action==='voice-settings'){state.modal='toastlab';render();return;}
}
function handleSubmit(event) {
  event.preventDefault();const form=event.target;
  if(form.id==='auth-form'){authenticate(form);return;}
  if(form.id==='composer-form'){const input=$('#composer-input');const text=input?.value||state.draft;sendMessage(text);return;}
  if(form.id==='create-server-form'){createServer(form);return;}
  if(form.id==='join-server-form'){joinServer(form);return;}
  if(form.id==='create-channel-form'){createChannel(form);return;}
  if(form.id==='new-dm-form'){createDm(form);return;}
  if(form.id==='profile-form'){saveProfile(form);return;}
  if(form.id==='edit-message-form'){editMessage();return;}
  if(form.id==='admin-server-form'){saveAdminServer(form);return;}
}
function handleInput(event) {
  if(event.target.id==='composer-input'){state.draft=event.target.value;event.target.style.height='auto';event.target.style.height=Math.min(150,event.target.scrollHeight)+'px';}
  if(event.target.id==='chat-search'){state.messageSearch=event.target.value;const at=event.target.selectionStart;const current=event.target.value;render();const next=$('#chat-search');if(next){next.focus();next.setSelectionRange(at,at);} }
}
function handleKeydown(event) {
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(state.me){state.modal='toastlab';render();}}
  if(event.key==='Escape'&&state.modal){state.modal='';render();}
  if(event.target.id==='composer-input'&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#composer-form')?.requestSubmit();}
  if(event.key==='/'&&state.me&&!['INPUT','TEXTAREA'].includes(event.target.tagName)&&!state.modal){event.preventDefault();$('#chat-search')?.focus();}
}
async function maybeJoinFromInvite() {
  const params=new URLSearchParams(location.search);const invite=params.get('invite');if(!invite||!state.me)return;
  try{const d=await api('/api/servers/join',{method:'POST',body:{inviteCode:invite}});if(!state.servers.some(s=>s.id===d.server.id))state.servers.push(d.server);state.channels=state.channels.filter(c=>c.serverId!==d.server.id).concat(d.channels);state.mode='channel';state.activeServerId=d.server.id;state.activeChannelId=d.channels.find(c=>c.kind==='text')?.id||d.channels[0]?.id;history.replaceState({},'',location.pathname);await refreshView();toast(`Du bist ${d.server.name} beigetreten.`,'success');}catch(e){toast(e.message,'error');}
}

document.addEventListener('click',handleClick);
document.addEventListener('submit',handleSubmit);
document.addEventListener('input',handleInput);
document.addEventListener('keydown',handleKeydown);
const historyElement=()=>$('#chat-history');
document.addEventListener('scroll',event=>{if(event.target?.id==='chat-history')state.userScrolled=event.target.scrollHeight-event.target.scrollTop-event.target.clientHeight>100;},true);
window.addEventListener('beforeunload',()=>{state.wsIntentionalClose=true;try{sendWs({type:'leave_voice',channelId:state.voiceChannelId});state.ws?.close();}catch{}for(const {pc} of state.peerConnections.values())pc.close();for(const t of state.localStream?.getTracks()||[])t.stop();});
(async()=>{try{const d=await api('/api/me');state.me=d.user;await boot();await maybeJoinFromInvite();}catch{renderAuth();}})();
