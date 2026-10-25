import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, ws } from '@appdeploy/client';
import {
  Hash, Volume2, Plus, Compass, MessageCircle, Settings, Search, HelpCircle,
  Smile, Send, ChevronDown, Users, Bell, Menu, X, LogOut, AtSign, Mic, MicOff,
  Phone, PhoneOff, Copy, Pencil, Trash2, UserPlus, Server, MoreHorizontal,
  ShieldCheck, Headphones, Link2, Gift, ChevronRight, Radio, Paperclip, Video, Ban, UserX,
  Sparkles, Bookmark
} from 'lucide-react';
import './index.css';
import './attachments.css';
import './realtime-fixes.css';
import './toastlab.css';
import RewardsPanel from './RewardsPanel';
import ToastLab from './ToastLab';

type Account = { userId: string; email?: string; name?: string; picture?: string; scope: string };
type Profile = { id: string; userId: string; displayName: string; email?: string; picture?: string; banner?: string; status: string; createdAt?: number; badges?: string[] };
type RewardWallet = { points: number; badges: string[]; gifts: Record<string, number>; ownedItems: string[]; proUntil: number; isPro: boolean; maxUploadBytes: number };
type ServerInfo = { id: string; name: string; ownerId: string; inviteCode: string; createdAt: number; description?: string; role?: 'owner' | 'admin' | 'moderator' | 'member' };
type Channel = { id: string; serverId: string; name: string; kind: 'text' | 'voice'; createdAt: number };
type ChatAttachment = { id: string; name: string; contentType: string; size: number };
type ChatMessage = { id: string; channelId?: string; threadId?: string; authorId: string; author: string; text: string; createdAt: number; editedAt?: number; reactions?: Record<string, string[]>; deleted?: boolean; attachments?: ChatAttachment[]; authorPicture?: string; authorBadges?: string[] };
type DMThread = { id: string; participants: string[]; otherUserId: string; otherDisplayName: string; createdAt: number };
type PublicMember = { userId: string; displayName: string; status: string; picture?: string; role?: string };
type VoicePeer = { userId: string; displayName: string; connectionId?: string };

const initialColors = ['#5865f2', '#ed4245', '#3ba55c', '#faa61a', '#9b59b6', '#eb459e', '#00a8fc'];
const voiceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

function Avatar({ name, picture, size = 'normal' }: { name: string; picture?: string; size?: 'normal' | 'small' | 'large' }) {
  const color = initialColors[(name.charCodeAt(0) || 0) % initialColors.length];
  return picture
    ? <img className={'avatar avatar-' + size} src={picture} alt="" />
    : <span className={'avatar avatar-' + size} style={{ background: color }}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}

function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rewards, setRewards] = useState<RewardWallet | null>(null);
  const [serverMembersRevision, setServerMembersRevision] = useState(0);
  const [voiceParticipants, setVoiceParticipants] = useState<VoicePeer[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeServerId, setActiveServerId] = useState('');
  const [activeChannelId, setActiveChannelId] = useState('');
  const [mode, setMode] = useState<'channel' | 'dm'>('channel');
  const [threads, setThreads] = useState<DMThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [messageLoadError, setMessageLoadError] = useState('');
  const [savedMessages, setSavedMessages] = useState<ChatMessage[]>([]);
  const [savedLoadedFor, setSavedLoadedFor] = useState('');
  const [focusMode, setFocusMode] = useState(false);
  const [presenceStatus, setPresenceStatus] = useState('online');
  const [filter, setFilter] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<null | 'server' | 'join' | 'channel' | 'invite' | 'dm' | 'profile' | 'settings' | 'shop' | 'admin' | 'toastlab'>(null);
  const [formText, setFormText] = useState('');
  const [newChannelKind, setNewChannelKind] = useState<'text' | 'voice'>('text');
  const [inviteCode, setInviteCode] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberResults, setMemberResults] = useState<PublicMember[]>([]);
  const [voiceChannelId, setVoiceChannelId] = useState('');
  const [muted, setMuted] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [turnAvailable, setTurnAvailable] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<ChatAttachment[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteNames, setRemoteNames] = useState<Record<string, string>>({});
  const [connectionReady, setConnectionReady] = useState(false);

  const connRef = useRef<ReturnType<typeof ws.connect> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>(voiceServers);
  const currentViewRef = useRef<{ type: 'channel' | 'dm'; id: string }>({ type: 'channel', id: '' });
  const accountRef = useRef<Account | null>(null);
  const voiceChannelRef = useRef('');
  const voiceViewChannelRef = useRef('');
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Record<string, RTCPeerConnection>>({});
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const makingOfferRef = useRef<Record<string, boolean>>({});
  const ignoreOfferRef = useRef<Record<string, boolean>>({});
  const voiceHandlerRef = useRef<(msg: any) => void>(() => {});
  const noticeTimerRef = useRef<number | null>(null);

  const activeServer = servers.find(s => s.id === activeServerId) || servers[0];
  const serverChannels = channels.filter(c => c.serverId === activeServer?.id);
  const activeChannel = channels.find(c => c.id === activeChannelId) || serverChannels.find(c => c.kind === 'text') || serverChannels[0];
  const activeThread = threads.find(t => t.id === activeThreadId);
  const isInVoice = !!voiceChannelId;
  const currentTitle = mode === 'dm' ? (activeThread?.otherDisplayName || 'Direktnachricht') : (activeChannel?.name || 'general');
  const draftStorageKey = account ? 'toastcord-draft-' + account.userId + '-' + mode + '-' + (mode === 'dm' ? activeThreadId : (activeChannel?.id || '')) : '';
  voiceViewChannelRef.current = activeChannel?.kind === 'voice' ? activeChannel.id : '';
  const visibleMessages = useMemo(() => messages.filter(m => {
    const matchesView = mode === 'dm' ? m.threadId === activeThreadId : m.channelId === activeChannel?.id;
    return matchesView && !m.deleted && (!filter || m.text.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  }), [messages, mode, activeThreadId, activeChannel?.id, filter]);

  function toast(text: string) {
    setNotice(text);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 5000);
  }

  useEffect(() => {
    let live = true;
    auth.getUser().then(u => { if (live) setAccount(u); }).catch(() => { if (live) setAccount(null); }).finally(() => { if (live) setAuthLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    accountRef.current = account;
    if (!account) {
      setProfile(null);
      setRewards(null);
      setConnectionReady(false);
      return;
    }
    let alive = true;
    setBusy(true);
    api.get('/api/bootstrap').then(r => {
      if (!alive) return;
      setProfile(r.data.me);
      setRewards(r.data.wallet || null);
      const loadedServers = (r.data.servers || []) as ServerInfo[];
      const loadedChannels = (r.data.channels || []) as Channel[];
      const loadedThreads = (r.data.threads || []) as DMThread[];
      setServers(loadedServers);
      setChannels(loadedChannels);
      setThreads(loadedThreads);
      // Restore the same server, channel, and DM when possible. Never restore a channel from another server.
      let initialServerId = loadedServers[0]?.id || '';
      let initialChannelId = '';
      let initialThreadId = '';
      let initialMode: 'channel' | 'dm' = 'channel';
      try {
        const savedServerId = localStorage.getItem('toastcord-active-server') || '';
        if (loadedServers.some(s => s.id === savedServerId)) initialServerId = savedServerId;
        const savedChannelId = localStorage.getItem('toastcord-active-channel') || '';
        if (loadedChannels.some(c => c.id === savedChannelId && c.serverId === initialServerId)) initialChannelId = savedChannelId;
        const savedThreadId = localStorage.getItem('toastcord-active-thread') || '';
        if (loadedThreads.some(t => t.id === savedThreadId)) initialThreadId = savedThreadId;
        if (localStorage.getItem('toastcord-mode') === 'dm' && initialThreadId) initialMode = 'dm';
      } catch {}
      if (!initialChannelId) initialChannelId = loadedChannels.find(c => c.serverId === initialServerId && c.kind === 'text')?.id
        || loadedChannels.find(c => c.serverId === initialServerId)?.id
        || '';
      setActiveServerId(initialServerId);
      setActiveChannelId(initialChannelId);
      setActiveThreadId(initialThreadId || loadedThreads[0]?.id || '');
      setMode(initialMode);
    }).catch(() => { if (alive) toast('Der Server ist gerade nicht erreichbar. Bitte lade die Seite neu.'); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [account?.userId]);

  useEffect(() => {
    if (!account) { setSavedLoadedFor(''); return; }
    setSavedLoadedFor('');
    try {
      const raw = localStorage.getItem('toastcord-saved-' + account.userId);
      setSavedMessages(raw ? (JSON.parse(raw) as ChatMessage[]) : []);
      setPresenceStatus(profile?.status || localStorage.getItem('toastcord-status-' + account.userId) || 'online');
    } catch { setSavedMessages([]); setPresenceStatus('online'); }
    setSavedLoadedFor(account.userId);
  }, [account?.userId]);

  useEffect(() => {
    if (!account || savedLoadedFor !== account.userId) return;
    try { localStorage.setItem('toastcord-saved-' + account.userId, JSON.stringify(savedMessages.slice(-100))); } catch {}
  }, [account?.userId, savedLoadedFor, savedMessages]);

  useEffect(() => {
    if (account && draftStorageKey) { try { setDraft(localStorage.getItem(draftStorageKey) || ''); } catch { setDraft(''); } }
  }, [account?.userId, mode, activeThreadId, activeChannel?.id]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setModal('toastlab');
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    if (!account || servers.length === 0) return;
    try {
      localStorage.setItem('toastcord-active-server', activeServerId);
      localStorage.setItem('toastcord-active-channel', activeChannelId);
      localStorage.setItem('toastcord-active-thread', activeThreadId);
      localStorage.setItem('toastcord-mode', mode);
    } catch {}
  }, [account?.userId, servers.length, activeServerId, activeChannelId, activeThreadId, mode]);

  useEffect(() => {
    if (!account) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite');
    if (!code) return;
    api.post('/api/servers/join', { inviteCode: code }).then(r => {
      setServers(prev => prev.some(s => s.id === r.data.server.id) ? prev : [...prev, r.data.server]);
      setChannels(prev => [...prev.filter(c => c.serverId !== r.data.server.id), ...(r.data.channels || [])]);
      setActiveServerId(r.data.server.id);
      setActiveChannelId((r.data.channels || []).find((c: Channel) => c.kind === 'text')?.id || '');
      setMode('channel');
      toast('Du bist dem Server ' + r.data.server.name + ' beigetreten.');
      window.history.replaceState({}, '', window.location.pathname);
    }).catch(() => toast('Der Einladungslink ist ungültig oder abgelaufen.'));
  }, [account?.userId]);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    setConnectionReady(false);
    const c = ws.connect();
    connRef.current = c;
    c.onMessage((msg: any) => {
      if (msg?.type === 'entity.update') {
        const payload = msg.payload;
        if (payload?.entity_type === 'server-members') {
          setServerMembersRevision(value => value + 1);
        }
        if (payload?.entity_type === 'voice-presence' && payload?.entity_id === voiceViewChannelRef.current) {
          const event = payload.data;
          if (event?.action === 'joined' && event.participant?.userId) {
            setVoiceParticipants(prev => prev.some(p => p.userId === event.participant.userId)
              ? prev.map(p => p.userId === event.participant.userId ? event.participant : p)
              : [...prev, event.participant]);
          } else if (event?.action === 'left' && event.userId) {
            setVoiceParticipants(prev => prev.filter(p => p.userId !== event.userId));
          }
        }
        const view = currentViewRef.current;
        if (payload?.entity_type === view.type && payload?.entity_id === view.id) {
          const incoming = payload.data as ChatMessage;
          if (incoming?.id) setMessages(prev => incoming.deleted ? prev.filter(m => m.id !== incoming.id) : (prev.some(m => m.id === incoming.id) ? prev.map(m => m.id === incoming.id ? incoming : m) : [...prev, incoming]));
        }
      }
      voiceHandlerRef.current(msg);
    });
    c.onError(() => toast('Die Live-Verbindung ist unterbrochen. Es wird erneut verbunden, falls möglich.'));
    c.ready.then(async () => {
      if (!alive || !c.connectionId) return;
      try {
        await api.post('/api/ws/register', { connectionId: c.connectionId });
        if (alive) setConnectionReady(true);
      } catch { if (alive) toast('Live-Verbindung konnte nicht registriert werden. Bitte Seite neu laden.'); }
    }).catch(() => { if (alive) toast('Live-Verbindung konnte nicht aufgebaut werden.'); });
    return () => {
      alive = false;
      setConnectionReady(false);
      c.disconnect();
      if (connRef.current === c) connRef.current = null;
    };
  }, [account?.userId]);

  useEffect(() => {
    const id = mode === 'dm' ? activeThreadId : (activeChannel?.id || '');
    const type = mode === 'dm' ? 'dm' : 'channel';
    currentViewRef.current = { type, id };
    if (!account || !id) return;
    let alive = true;
    setMessageLoadError('');
    api.get(mode === 'dm' ? '/api/dm/messages' : '/api/messages', mode === 'dm' ? { threadId: id } : { channelId: id }).then(r => {
      if (alive) { setMessages(prev => [...prev.filter(m => mode === 'dm' ? m.threadId !== id : m.channelId !== id), ...(r.data.messages || [])]); setMessageLoadError(''); }
    }).catch((err: any) => { if (alive) { const reason = err?.response?.data?.error || 'Nachrichten konnten nicht geladen werden.'; setMessageLoadError(reason); toast(reason); } });
    return () => { alive = false; };
  }, [account?.userId, mode, activeThreadId, activeChannel?.id]);

  useEffect(() => {
    if (!account || !connectionReady || !connRef.current?.connectionId) return;
    const id = mode === 'dm' ? activeThreadId : (activeChannel?.id || '');
    const type = mode === 'dm' ? 'dm' : 'channel';
    const connectionId = connRef.current.connectionId;
    if (!id) return;
    api.post('/api/subscriptions', { entity_type: type, entity_id: id, connection_id: connectionId }).catch(() => {});
    return () => { api.post('/api/subscriptions/remove', { entity_type: type, entity_id: id, connection_id: connectionId }).catch(() => {}); };
  }, [account?.userId, connectionReady, mode, activeThreadId, activeChannel?.id]);

  useEffect(() => {
    if (!account || !connectionReady || !connRef.current?.connectionId || !activeServer?.id) return;
    const serverId = activeServer.id;
    const connectionId = connRef.current.connectionId;
    api.post('/api/subscriptions', { entity_type: 'server-members', entity_id: serverId, connection_id: connectionId }).catch(() => {});
    return () => {
      api.post('/api/subscriptions/remove', { entity_type: 'server-members', entity_id: serverId, connection_id: connectionId }).catch(() => {});
    };
  }, [account?.userId, connectionReady, activeServer?.id]);

  useEffect(() => {
    const channelId = activeChannel?.kind === 'voice' ? activeChannel.id : '';
    if (!account || !connectionReady || !connRef.current?.connectionId || !channelId) {
      if (!channelId) setVoiceParticipants([]);
      return;
    }
    let alive = true;
    const connectionId = connRef.current.connectionId;
    api.post('/api/subscriptions', { entity_type: 'voice-presence', entity_id: channelId, connection_id: connectionId })
      .then(() => api.get('/api/voice/participants', { channelId }))
      .then(r => {
        if (!alive) return;
        const incoming = (r.data.participants || []) as VoicePeer[];
        setVoiceParticipants(prev => {
          const merged = new Map(incoming.map(p => [p.userId, p]));
          // Preserve realtime joins that arrived while the initial participant request was in flight.
          for (const p of prev) if (!merged.has(p.userId)) merged.set(p.userId, p);
          return Array.from(merged.values());
        });
      })
      .catch(err => { if (alive) toast(err?.response?.data?.error || 'Sprachkanal-Teilnehmer konnten nicht geladen werden.'); });
    return () => {
      alive = false;
      api.post('/api/subscriptions/remove', { entity_type: 'voice-presence', entity_id: channelId, connection_id: connectionId }).catch(() => {});
      setVoiceParticipants([]);
    };
  }, [account?.userId, connectionReady, activeChannel?.id, activeChannel?.kind]);

  useEffect(() => {
    if (!account || modal !== 'dm' || !activeServer?.id) { setMemberResults([]); return; }
    const q = memberQuery.trim();
    if (!q) { setMemberResults([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => api.get('/api/members', { serverId: activeServer.id, q }).then(r => { if (alive) setMemberResults(r.data.members || []); }).catch(() => { if (alive) setMemberResults([]); }), 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [account?.userId, modal, memberQuery, activeServer?.id]);

  useEffect(() => {
    if (!account || !voiceChannelId) return;
    const timer = window.setInterval(() => {
      api.post('/api/rewards/voice-tick', { channelId: voiceChannelId }).then(r => {
        if (r.data.wallet) setRewards(r.data.wallet);
        if (r.data.pointsEarned) toast('+' + r.data.pointsEarned + ' Toast-Punkte für deine Sprachzeit!');
      }).catch(() => {});
    }, 60000);
    return () => window.clearInterval(timer);
  }, [account?.userId, voiceChannelId]);

  voiceChannelRef.current = voiceChannelId;
  const createPeer = useCallback((peer: VoicePeer) => {
    const existing = peersRef.current[peer.userId];
    if (existing) return existing;
    const channelId = voiceChannelRef.current;
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peersRef.current[peer.userId] = pc;
    setRemoteNames(prev => ({ ...prev, [peer.userId]: peer.displayName }));
    localStreamRef.current?.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
    screenStreamRef.current?.getTracks().forEach(track => pc.addTrack(track, screenStreamRef.current!));
    pc.onicecandidate = ev => {
      if (ev.candidate && voiceChannelRef.current === channelId) api.post('/api/voice/signal', { channelId, targetUserId: peer.userId, signal: { kind: 'ice', candidate: ev.candidate.toJSON() } }).catch(() => {});
    };
    pc.ontrack = ev => {
      setRemoteNames(prev => ({ ...prev, [peer.userId]: peer.displayName }));
      setRemoteStreams(prev => {
        // Combine audio and screen tracks into one stream per remote participant.
        const stream = prev[peer.userId] || new MediaStream();
        if (!stream.getTracks().some(track => track.id === ev.track.id)) stream.addTrack(ev.track);
        return { ...prev, [peer.userId]: stream };
      });
      ev.track.onended = () => setRemoteStreams(prev => {
        const current = prev[peer.userId];
        if (!current) return prev;
        current.removeTrack(ev.track);
        return { ...prev, [peer.userId]: new MediaStream(current.getTracks()) };
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') toast('Die Audio-Verbindung zu ' + peer.displayName + ' ist fehlgeschlagen. Prüfe Netzwerk und Mikrofon.');
    };
    return pc;
  }, []);
  const createPeerRef = useRef(createPeer);
  createPeerRef.current = createPeer;

  const sendVoiceSignal = useCallback((channelId: string, targetUserId: string, signal: unknown) => api.post('/api/voice/signal', { channelId, targetUserId, signal }).catch(() => toast('Audio-Signal konnte nicht gesendet werden.')), []);
  voiceHandlerRef.current = async (msg: any) => {
    const payload = msg?.payload;
    const me = accountRef.current;
    const currentVoiceId = voiceChannelRef.current;
    if (!me || !payload || payload.channelId !== currentVoiceId) return;
    if (msg.type === 'voice.peer-joined' && payload.userId && payload.userId !== me.userId) {
      const peer = { userId: payload.userId, displayName: payload.displayName || 'Mitglied' };
      setRemoteNames(prev => ({ ...prev, [peer.userId]: peer.displayName }));
      setVoiceParticipants(prev => prev.some(p => p.userId === peer.userId) ? prev : [...prev, peer]);
      if (me.userId.localeCompare(peer.userId) < 0) {
        const pc = createPeerRef.current(peer);
        try {
          makingOfferRef.current[peer.userId] = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendVoiceSignal(currentVoiceId, peer.userId, { kind: 'offer', description: pc.localDescription });
        } catch { toast('Audio-Angebot konnte nicht erstellt werden.'); }
        finally { makingOfferRef.current[peer.userId] = false; }
      }
    }
    if (msg.type === 'voice.peer-left' && payload.userId) {
      peersRef.current[payload.userId]?.close();
      delete peersRef.current[payload.userId];
      delete makingOfferRef.current[payload.userId];
      delete ignoreOfferRef.current[payload.userId];
      setRemoteStreams(prev => { const next = { ...prev }; delete next[payload.userId]; return next; });
      setRemoteNames(prev => { const next = { ...prev }; delete next[payload.userId]; return next; });
      setVoiceParticipants(prev => prev.filter(p => p.userId !== payload.userId));
    }
    if (msg.type !== 'voice.signal' || !payload.signal || !payload.fromUserId) return;
    const sender: VoicePeer = { userId: payload.fromUserId, displayName: payload.displayName || 'Mitglied' };
    const signal = payload.signal;
    const pc = createPeerRef.current(sender);
    try {
      if (signal.kind === 'offer') {
        const offerCollision = makingOfferRef.current[sender.userId] || pc.signalingState !== 'stable';
        const politePeer = me.userId.localeCompare(sender.userId) > 0;
        ignoreOfferRef.current[sender.userId] = !politePeer && offerCollision;
        if (ignoreOfferRef.current[sender.userId]) return;
        if (offerCollision && politePeer) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
        const queued = pendingIceRef.current[sender.userId] || [];
        for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
        delete pendingIceRef.current[sender.userId];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendVoiceSignal(currentVoiceId, sender.userId, { kind: 'answer', description: pc.localDescription });
      } else if (signal.kind === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
        const queued = pendingIceRef.current[sender.userId] || [];
        for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
        delete pendingIceRef.current[sender.userId];
      } else if (signal.kind === 'ice' && signal.candidate) {
        if (ignoreOfferRef.current[sender.userId]) return;
        const candidate = new RTCIceCandidate(signal.candidate);
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingIceRef.current[sender.userId] = [...(pendingIceRef.current[sender.userId] || []), signal.candidate];
      }
    } catch { toast('Fehler beim Verbinden des Sprachchats.'); }
  };

  async function signIn() {
    setBusy(true);
    try {
      const result = await auth.signIn({ scope: 'openid email profile offline_access' });
      setAccount(result.user);
      toast('Anmeldung erfolgreich. Toastcord wird vorbereitet …');
    } catch (err: any) {
      if (err?.code === 'popup_blocked') toast('Bitte erlaube Pop-ups für die Anmeldung.');
      else if (err?.code === 'popup_closed') toast('Anmeldung abgebrochen.');
      else toast('Anmeldung fehlgeschlagen. Versuche es erneut.');
    } finally { setBusy(false); }
  }

  async function signOut() {
    await stopVoice(false);
    try { await auth.signOut(); } catch {}
    setAccount(null); setProfile(null); setServers([]); setChannels([]); setThreads([]); setMessages([]);
    setActiveServerId(''); setActiveChannelId(''); setActiveThreadId(''); setMode('channel');
    toast('Du wurdest abgemeldet.');
  }

  async function refreshThreads() {
    try { const r = await api.get('/api/dms'); setThreads(r.data.threads || []); } catch {}
  }

  function updateDraft(next: string) {
    setDraft(next);
    if (account && draftStorageKey) { try { localStorage.setItem(draftStorageKey,next); } catch {} }
  }

  async function reloadMessages() {
    const id = mode === 'dm' ? activeThreadId : (activeChannel?.id || '');
    if (!account || !id) return;
    setMessageLoadError('');
    try {
      const response = await api.get(mode === 'dm' ? '/api/dm/messages' : '/api/messages', mode === 'dm' ? {threadId:id} : {channelId:id});
      setMessages(prev => [...prev.filter(m => mode === 'dm' ? m.threadId !== id : m.channelId !== id), ...(response.data.messages || [])]);
      setMessageLoadError(''); toast('Chat erfolgreich neu geladen.');
    } catch (err: any) { const reason = err?.response?.data?.error || 'Nachrichten konnten nicht geladen werden.'; setMessageLoadError(reason); toast(reason); }
  }

  function toggleSavedMessage(message: ChatMessage) {
    const exists = savedMessages.some(item => item.id === message.id);
    setSavedMessages(prev => exists ? prev.filter(item => item.id !== message.id) : [...prev, message].slice(-100));
    toast(exists ? 'Aus der Merkliste entfernt.' : 'Nachricht in ToastLab gespeichert.');
  }

  function openSavedMessage(message: ChatMessage) {
    if (message.threadId) { setActiveThreadId(message.threadId); setMode('dm'); }
    else if (message.channelId) {
      const channel = channels.find(item => item.id === message.channelId);
      if (channel) { setActiveServerId(channel.serverId); setActiveChannelId(channel.id); setMode('channel'); }
    }
    setModal(null); setFilter('');
  }

  async function savePresence(status: string) {
    try {
      const response = await api.put('/api/profile/status',{status});
      setPresenceStatus(response.data.status || status);
      setProfile(prev => prev ? {...prev,status:response.data.status || status} : prev);
      try { if (account) localStorage.setItem('toastcord-status-' + account.userId,status); } catch {}
      toast('Status geändert: ' + ({online:'Online',away:'Abwesend',dnd:'Nicht stören',offline:'Unsichtbar'} as Record<string,string>)[status]);
    } catch (err: any) { toast(err?.response?.data?.error || 'Status konnte nicht gespeichert werden.'); }
  }

  async function sendMessage(e?: any) {
    e?.preventDefault();
    let text = draft.trim();
    const command = text.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (command) {
      const name = command[1].toLowerCase(); const args = (command[2] || '').trim();
      if (name === 'help') { toast('/roll · /flip · /choose A | B · /shrug · /me Aktion · /poll Frage | Option 1 | Option 2'); return; }
      if (name === 'roll') text = '🎲 ' + (profile?.displayName || account?.name || 'Du') + ' würfelt: ' + (Math.floor(Math.random() * 6) + 1);
      else if (name === 'flip') text = '🪙 ' + (profile?.displayName || account?.name || 'Du') + ': ' + (Math.random() < 0.5 ? 'Kopf' : 'Zahl');
      else if (name === 'choose') { const values = args.split('|').map(v=>v.trim()).filter(Boolean); if (values.length < 2) { toast('Nutze /choose Option A | Option B'); return; } text = '🎯 Entscheidung: ' + values[Math.floor(Math.random() * values.length)]; }
      else if (name === 'shrug') text = (args ? args + ' ' : '') + '¯\\_(ツ)_/¯';
      else if (name === 'me') { if (!args) { toast('Nutze /me und dann eine Aktion.'); return; } text = '* ' + args + ' *'; }
      else if (name === 'poll') { const parts = args.split('|').map(v=>v.trim()).filter(Boolean); if (parts.length < 3) { toast('Nutze /poll Frage | Option 1 | Option 2'); return; } text = '📊 UMFRAGE: ' + parts[0] + '\n\n' + parts.slice(1,9).map((option,index)=>['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'][index] + ' ' + option).join('\n') + '\n\nReagiere mit der passenden Zahl.'; }
      else { toast('Unbekannter Befehl. Tippe /help für die Liste.'); return; }
    }
    if ((!text && pendingUploads.length === 0) || !account || busy || (mode === 'channel' && activeChannel?.kind === 'voice')) return;
    setBusy(true);
    try {
      const r = mode === 'dm'
        ? await api.post('/api/dm/messages', { threadId: activeThreadId, text, attachments: pendingUploads.map(file => file.id) })
        : await api.post('/api/messages', { channelId: activeChannel?.id, text, attachments: pendingUploads.map(file => file.id) });
      const m = r.data.message as ChatMessage;
      setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, m]);
      if (r.data.wallet) setRewards(r.data.wallet);
      if (r.data.pointsEarned) toast('+' + r.data.pointsEarned + ' Toast-Punkte!');
      setDraft('');
      if (draftStorageKey) { try { localStorage.removeItem(draftStorageKey); } catch {} }
      setPendingUploads([]);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Nachricht konnte nicht gespeichert werden. Prüfe deine Verbindung.');
    } finally { setBusy(false); }
  }

  async function createServer(e: any) {
    e.preventDefault();
    const name = formText.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await api.post('/api/servers', { name });
      setServers(prev => [...prev.filter(s => s.id !== r.data.server.id), r.data.server]);
      setChannels(prev => [...prev, ...(r.data.channels || []).filter((c: Channel) => !prev.some(old => old.id === c.id))]);
      setActiveServerId(r.data.server.id);
      setActiveChannelId((r.data.channels || []).find((c: Channel) => c.kind === 'text')?.id || '');
      setMode('channel'); setFormText(''); setModal(null);
      toast('Server erstellt. Lade Freunde ein, damit der Chat nicht ganz so einsam bleibt.');
    } catch { toast('Server konnte nicht erstellt werden.'); } finally { setBusy(false); }
  }

  async function createChannel(e: any) {
    e.preventDefault();
    const name = formText.trim();
    if (!name || !activeServer) return;
    setBusy(true);
    try {
      const r = await api.post('/api/channels', { serverId: activeServer.id, name, kind: newChannelKind });
      setChannels(prev => [...prev.filter(c => c.id !== r.data.channel.id), r.data.channel]);
      setActiveChannelId(r.data.channel.id); setMode('channel'); setFormText(''); setModal(null);
      toast('Kanal erstellt.');
    } catch { toast('Kanal konnte nicht erstellt werden.'); } finally { setBusy(false); }
  }

  async function joinServer(e?: any) {
    e?.preventDefault();
    const code = formText.trim();
    if (!code) return;
    setBusy(true);
    try {
      const r = await api.post('/api/servers/join', { inviteCode: code });
      setServers(prev => [...prev.filter(s => s.id !== r.data.server.id), r.data.server]);
      setChannels(prev => [...prev.filter(c => !r.data.channels.some((n: Channel) => n.id === c.id)), ...(r.data.channels || [])]);
      setActiveServerId(r.data.server.id);
      setActiveChannelId((r.data.channels || []).find((c: Channel) => c.kind === 'text')?.id || '');
      setMode('channel'); setModal(null); setFormText('');
      toast('Server beigetreten.');
    } catch { toast('Einladung ungültig. Lass dir einen aktuellen Einladungs-Code geben.'); } finally { setBusy(false); }
  }

  async function makeInvite() {
    if (!activeServer) return;
    setBusy(true);
    try { const r = await api.post('/api/servers/invite', { serverId: activeServer.id }); setInviteCode(r.data.inviteCode); setModal('invite'); }
    catch { toast('Einladung konnte nicht erstellt werden.'); } finally { setBusy(false); }
  }

  async function copyInvite() {
    const link = window.location.origin + '/?invite=' + encodeURIComponent(inviteCode);
    try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert.'); }
    catch { setFormText(link); toast('Kopiere den angezeigten Link manuell.'); }
  }

  async function startDM(member: PublicMember) {
    if (!account || member.userId === account.userId) return;
    setBusy(true);
    try {
      const r = await api.post('/api/dms/create', { recipientId: member.userId });
      const t = r.data.thread as DMThread;
      setThreads(prev => [...prev.filter(old => old.id !== t.id), t]);
      setActiveThreadId(t.id); setMode('dm'); setModal(null); setMemberQuery(''); setFilter('');
      toast('Direktnachricht geöffnet.');
    } catch { toast('Direktnachricht konnte nicht geöffnet werden. Ihr braucht einen gemeinsamen Server.'); }
    finally { setBusy(false); }
  }

  async function updateProfile(e: any) {
    e.preventDefault();
    const displayName = formText.trim();
    if (!displayName) return;
    setBusy(true);
    try {
      const r = await api.put('/api/profile', { displayName });
      setProfile(r.data.me); setModal(null); setFormText('');
      toast('Profil gespeichert.');
    } catch { toast('Profil konnte nicht gespeichert werden.'); }
    finally { setBusy(false); }
  }

  async function messageAction(action: 'edit' | 'delete' | 'react', message: ChatMessage) {
    if (!account) return;
    if (action === 'edit') {
      const updated = window.prompt('Nachricht bearbeiten', message.text);
      if (updated === null || !updated.trim()) return;
      try {
        const r = mode === 'dm'
          ? await api.put('/api/dm/messages/' + message.id, { text: updated.trim() })
          : await api.put('/api/messages/' + message.id, { text: updated.trim() });
        setMessages(prev => prev.map(m => m.id === message.id ? r.data.message : m));
      } catch { toast('Nachricht konnte nicht bearbeitet werden.'); }
    } else if (action === 'delete') {
      if (!window.confirm('Diese Nachricht wirklich löschen?')) return;
      try {
        if (mode === 'dm') await api.delete('/api/dm/messages/' + message.id);
        else await api.delete('/api/messages/' + message.id);
        setMessages(prev => prev.filter(m => m.id !== message.id));
      } catch { toast('Nachricht konnte nicht gelöscht werden.'); }
    } else {
      try {
        const r = mode === 'dm'
          ? await api.post('/api/dm/messages/' + message.id + '/reaction', { emoji: '🍞' })
          : await api.post('/api/messages/' + message.id + '/reaction', { emoji: '🍞' });
        setMessages(prev => prev.map(m => m.id === message.id ? r.data.message : m));
      } catch { toast('Reaktion konnte nicht gespeichert werden.'); }
    }
  }

  async function startVoice(channel: Channel) {
    if (!account || !connectionReady || !connRef.current?.connectionId) {
      toast('Die Live-Verbindung ist noch nicht bereit. Warte einen Moment und versuche es erneut.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Dein Browser unterstützt hier keinen Mikrofonzugriff. Nutze eine aktuelle Version von Chrome, Edge oder Opera.');
      return;
    }
    try {
      try {
        const ice = await api.get('/api/voice/config');
        if (Array.isArray(ice.data.iceServers) && ice.data.iceServers.length) iceServersRef.current = ice.data.iceServers;
        setTurnAvailable(Boolean(ice.data.turnConfigured));
      } catch { iceServersRef.current = voiceServers; setTurnAvailable(false); }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      localStreamRef.current = stream; setVoiceChannelId(channel.id); voiceChannelRef.current = channel.id; setMuted(false);
      const r = await api.post('/api/voice/join', { channelId: channel.id, connectionId: connRef.current.connectionId });
      const peers: VoicePeer[] = r.data.peers || [];
      setRemoteNames(Object.fromEntries(peers.map(p => [p.userId, p.displayName])));
      setVoiceParticipants(prev => {
        const map = new Map(prev.map(p => [p.userId, p]));
        for (const peer of peers) map.set(peer.userId, peer);
        map.set(account.userId, { userId: account.userId, displayName: profile?.displayName || account.name || 'Du' });
        return Array.from(map.values());
      });
      for (const peer of peers) {
        // Only the lexicographically lower user creates the initial offer for this pair.
        if (account.userId.localeCompare(peer.userId) < 0) {
          const pc = createPeerRef.current(peer);
          try {
            makingOfferRef.current[peer.userId] = true;
            if (pc.signalingState !== 'stable') continue;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await api.post('/api/voice/signal', { channelId: channel.id, targetUserId: peer.userId, signal: { kind: 'offer', description: pc.localDescription } });
          } catch { toast('Verbindung zu ' + peer.displayName + ' konnte nicht gestartet werden.'); }
          finally { makingOfferRef.current[peer.userId] = false; }
        }
      }
      toast('Du bist im Sprachkanal. Dein Browser fragt nach Mikrofon-Zugriff, falls das noch nicht erlaubt ist.');
    } catch (err: any) {
      localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null; setVoiceChannelId(''); voiceChannelRef.current = '';
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') toast('Mikrofonzugriff wurde verweigert. Erlaube das Mikrofon in den Browser-Einstellungen.');
      else toast(err?.response?.data?.error || 'Sprachchat konnte nicht gestartet werden.');
    }
  }

  async function stopVoice(showToast = true) {
    const id = voiceChannelRef.current;
    await stopScreenShare(false);
    voiceChannelRef.current = ''; setVoiceChannelId(''); setMuted(false);
    setVoiceParticipants(prev => prev.filter(p => p.userId !== accountRef.current?.userId));
    if (id) api.post('/api/voice/leave', { channelId: id }).catch(() => {});
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null;
    Object.values(peersRef.current).forEach(pc => pc.close()); peersRef.current = {}; pendingIceRef.current = {};
    setRemoteStreams({}); setRemoteNames({});
    if (showToast && id) toast('Du hast den Sprachkanal verlassen.');
  }

  async function uploadFiles(event: any) {
    const selected = Array.from((event.target.files || []) as File[]);
    event.target.value = '';
    if (!selected.length) return;
    if (pendingUploads.length + selected.length > 5) { toast('Maximal fünf Dateien pro Nachricht.'); return; }
    if (mode === 'dm' && !activeThreadId) { toast('Öffne zuerst eine Direktnachricht.'); return; }
    if (mode === 'channel' && (!activeChannel || activeChannel.kind !== 'text')) { toast('Dateien können nur in Textkanälen oder Direktnachrichten gesendet werden.'); return; }
    setBusy(true);
    try {
      for (const file of selected) {
        const maxFileSize = rewards?.maxUploadBytes || 10 * 1024 * 1024;
        if (file.size > maxFileSize) { toast(file.name + ' ist größer als dein Upload-Limit von ' + Math.round(maxFileSize / 1024 / 1024) + ' MB.'); continue; }
        const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'application/pdf', 'text/plain', 'application/zip', 'application/x-7z-compressed'].includes(file.type);
        if (!allowed) { toast(file.name + ': Dateityp nicht erlaubt.'); continue; }
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
          reader.readAsDataURL(file);
        });
        const result = await api.post('/api/files', { name: file.name, contentType: file.type, size: file.size, base64, channelId: mode === 'channel' ? activeChannel?.id : undefined, threadId: mode === 'dm' ? activeThreadId : undefined });
        setPendingUploads(prev => [...prev, result.data.attachment]);
      }
    } catch (err: any) { toast(err?.response?.data?.error || 'Upload fehlgeschlagen. Prüfe die Verbindung und Dateigröße.'); }
    finally { setBusy(false); }
  }

  async function renegotiatePeer(peerId: string, attempt = 0) {
    const channelId = voiceChannelRef.current;
    const pc = peersRef.current[peerId];
    if (!channelId || !pc) return;
    if (pc.signalingState !== 'stable') {
      if (attempt < 12) window.setTimeout(() => { void renegotiatePeer(peerId, attempt + 1); }, 250);
      return;
    }
    try {
      makingOfferRef.current[peerId] = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await api.post('/api/voice/signal', { channelId, targetUserId: peerId, signal: { kind: 'offer', description: pc.localDescription } });
    } catch { toast('Medienverbindung konnte nicht aktualisiert werden.'); }
    finally { makingOfferRef.current[peerId] = false; }
  }

  async function toggleScreenShare() {
    if (!voiceChannelRef.current || !localStreamRef.current) { toast('Tritt zuerst einem Sprachkanal bei.'); return; }
    if (screenStreamRef.current) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast('Dein Browser unterstützt keine Bildschirmfreigabe.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      stream.getVideoTracks()[0].onended = () => { void stopScreenShare(); };
      for (const [peerId, pc] of Object.entries(peersRef.current)) {
        stream.getVideoTracks().forEach(track => pc.addTrack(track, stream));
        await renegotiatePeer(peerId);
      }
      toast('Bildschirmfreigabe gestartet (bis zu 30 FPS). Browser und Betriebssystem zeigen an, was geteilt wird.');
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast('Bildschirmfreigabe konnte nicht gestartet werden. Prüfe die Browserfreigabe.');
    }
  }

  async function stopScreenShare(showToast = true) {
    const stream = screenStreamRef.current;
    if (!stream) return;
    const tracks = stream.getTracks();
    screenStreamRef.current = null;
    setScreenStream(null);
    for (const [peerId, pc] of Object.entries(peersRef.current)) {
      pc.getSenders().filter(sender => sender.track && tracks.includes(sender.track)).forEach(sender => pc.removeTrack(sender));
      if (voiceChannelRef.current) await renegotiatePeer(peerId);
    }
    tracks.forEach(track => { track.onended = null; track.stop(); });
    if (showToast) toast('Bildschirmfreigabe beendet.');
  }

  function toggleMute() {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  }

  if (authLoading) return <div className="loading-shell"><div className="brand-mark">✦</div><div className="spinner"/><p>Toastcord wird gestartet …</p></div>;
  if (!account) return <div className="login-shell"><div className="login-card"><div className="brand-mark big">✦</div><div className="eyebrow">DEIN COMMUNITY-SPACE</div><h1>Willkommen bei Toastcord</h1><p>Spiele, Server, Freunde und Chats. Ein Zuhause für deine Community, ohne die Bedienung eines Flugzeugcockpits.</p><button className="primary wide" disabled={busy} onClick={signIn}>{busy ? 'Anmeldung wird geöffnet …' : 'Anmelden oder Konto erstellen'} <ChevronRight size={18}/></button><div className="login-methods"><span><ShieldCheck size={15}/> Sichere Anmeldung</span><span><MailIcon/> E-Mail oder unterstützter Anbieter</span></div><small>Du wirst in einem sicheren Anmeldefenster angemeldet. Toastcord speichert keine Passwörter.</small></div><div className="login-foot">TOASTCORD · GEMACHT FÜR COMMUNITYS</div>{notice && <div className="notice login-notice"><span>{notice}</span><button onClick={() => setNotice('')}><X size={16}/></button></div>}</div>;

  return <div className={'app-shell' + (focusMode ? ' focus-mode' : '')}>
    <aside className={'server-rail ' + (mobileNav ? 'mobile-open' : '')}>
      <button className="server-logo home-logo" title="Direktnachrichten" onClick={() => { setMode('dm'); setActiveThreadId(threads[0]?.id || ''); setMobileNav(false); }}><MessageCircle/></button>
      <div className="rail-line"/>
      {servers.map(server => <button key={server.id} className={'server-logo ' + (activeServer?.id === server.id && mode === 'channel' ? 'selected' : '')} title={server.name} onClick={() => { setActiveServerId(server.id); const ch = channels.find(c => c.serverId === server.id && c.kind === 'text') || channels.find(c => c.serverId === server.id); setActiveChannelId(ch?.id || ''); setMode('channel'); setMobileNav(false); }}><span>{server.name.slice(0, 1).toUpperCase()}</span></button>)}
      <button className="add-server" title="Server erstellen" onClick={() => { setFormText(''); setModal('server'); }}><Plus/></button>
      <button className="add-server explore" title="Server beitreten" onClick={() => { setFormText(''); setModal('join'); }}><Compass/></button>
      <button className="mobile-close" onClick={() => setMobileNav(false)}><X/></button>
    </aside>

    <aside className={'channel-sidebar ' + (mobileNav ? 'mobile-open' : '')}>
      {mode === 'dm'
        ? <button className="workspace-head" onClick={() => setMode('channel')}><span>Direktnachrichten</span><ChevronDown size={18}/></button>
        : <button className="workspace-head" onClick={makeInvite}><span>{activeServer?.name || 'Toast Zone'}</span><ChevronDown size={18}/></button>}
      <div className="sidebar-scroll">
        <button className={'nav-row ' + (mode === 'dm' && !activeThreadId ? 'nav-selected' : '')} onClick={() => { setMode('dm'); setActiveThreadId(''); setMobileNav(false); }}><MessageCircle size={19}/> Nachrichten</button>
        <button className="nav-row" onClick={() => { setModal('dm'); setMemberQuery(''); setFormText(''); }}><UserPlus size={19}/> Freunde finden</button>
        <button className="nav-row" onClick={() => setModal('shop')}><Gift size={19}/> Toast-Shop · {(rewards?.points || 0).toLocaleString('de-DE')} Punkte</button>
        {mode === 'channel' ? <>
          <div className="section-title"><span>TEXTKANÄLE</span><button onClick={() => { setFormText(''); setNewChannelKind('text'); setModal('channel'); }} title="Textkanal erstellen"><Plus size={17}/></button></div>
          {serverChannels.filter(c => c.kind === 'text').map(c => <button key={c.id} className={'channel-row ' + (activeChannel?.id === c.id && mode === 'channel' ? 'chosen' : '')} onClick={() => { setActiveChannelId(c.id); setMode('channel'); setFilter(''); setMobileNav(false); }}><Hash size={18}/><span>{c.name}</span><span className="channel-hover"><MoreHorizontal size={15}/></span></button>)}
          <div className="section-title"><span>SPRACHKANÄLE</span><button onClick={() => { setFormText(''); setNewChannelKind('voice'); setModal('channel'); }} title="Sprachkanal erstellen"><Plus size={17}/></button></div>
          {serverChannels.filter(c => c.kind === 'voice').map(c => <button key={c.id} className={'channel-row ' + (activeChannel?.id === c.id ? 'chosen' : '')} onClick={() => { setActiveChannelId(c.id); setMode('channel'); setFilter(''); setMobileNav(false); }}><Volume2 size={18}/><span>{c.name}</span><span className="channel-hover"><Headphones size={14}/></span></button>)}
          <div className="voice-info"><div className="voice-status"><span className="green-dot"/>{isInVoice ? 'Im Sprachchat' : 'Sprachkanal bereit'}</div><small>{isInVoice ? 'Du hörst die verbundenen Mitglieder.' : 'Mikrofon wird erst beim Beitritt aktiviert.'}</small>{isInVoice && <button onClick={() => stopVoice()}><PhoneOff size={14}/> Verlassen</button>}</div>
        </> : <>
          <div className="section-title"><span>LETZTE NACHRICHTEN</span><button onClick={refreshThreads} title="Aktualisieren"><Plus size={17}/></button></div>
          {threads.map(t => <button key={t.id} className={'dm-row ' + (activeThreadId === t.id ? 'chosen' : '')} onClick={() => { setActiveThreadId(t.id); setMode('dm'); setFilter(''); setMobileNav(false); }}><Avatar name={t.otherDisplayName} size="small"/><span>{t.otherDisplayName}</span><span className="online-dot"/></button>)}
          {!threads.length && <div className="empty-sidebar">Noch keine Direktnachrichten.<br/>Such dir eine Person aus deiner Community.</div>}
        </>}
      </div>
      <div className="user-panel"><Avatar name={profile?.displayName || account.name || 'T'} picture={profile?.picture || account.picture}/><button className="user-copy user-profile-button" onClick={() => { setFormText(profile?.displayName || account.name || ''); setModal('profile'); }}><strong>{profile?.displayName || account.name || 'Toast-Nutzer'}</strong><small><span className="online-dot"/> {({online:'Online',away:'Abwesend',dnd:'Nicht stören',offline:'Unsichtbar'} as Record<string,string>)[presenceStatus] || 'Online'} · Profil</small></button><button title="Einstellungen" onClick={() => setModal('settings')}><Settings size={18}/></button><button title="Abmelden" onClick={signOut}><LogOut size={17}/></button></div>
    </aside>

    <main className="chat-main">
      <header className="chat-header"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu/></button>{mode === 'dm' ? <AtSign className="hash-head"/> : activeChannel?.kind === 'voice' ? <Volume2 className="hash-head"/> : <Hash className="hash-head"/>}<strong>{currentTitle}</strong><div className="header-divider"/><span className="channel-topic">{mode === 'dm' ? 'Direkt und nur für euch beide.' : activeChannel?.kind === 'voice' ? 'Sprachkanal mit echter Audio-Verbindung' : (activeChannel?.name === 'general' ? 'Willkommen in deiner Community 🍞' : 'Teile Ideen, Clips und gute Fragen.')}</span><div className="header-actions"><button title="ToastLab · 12 Extra-Funktionen · Strg+K" onClick={() => setModal('toastlab')}><Sparkles/></button><button title="Einladung erstellen" onClick={makeInvite}><Link2/></button><button title="Mitglieder" className={showMembers ? 'active-tool' : ''} onClick={() => setShowMembers(!showMembers)}><Users/></button><div className="search-box"><Search size={16}/><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Chat durchsuchen"/></div><button title="Benachrichtigungen"><Bell/></button><button title="Hilfe"><HelpCircle/></button></div></header>

      {mode === 'channel' && activeChannel?.kind === 'voice' ? <section className="voice-stage"><div className="voice-orb"><Radio size={38}/></div><div className="eyebrow">SPRACHKANAL</div><h1>{activeChannel.name}</h1><p>Mitglieder im Sprachkanal werden auch ohne fertigen Medienstream angezeigt.</p><div className="voice-participants">{isInVoice && voiceChannelId === activeChannel.id ? <div className="voice-person"><Avatar name={profile?.displayName || account.name || 'Du'} picture={profile?.picture}/><strong>{profile?.displayName || account.name || 'Du'} (Du)</strong><span className="voice-speaking">{muted ? <MicOff size={16}/> : <Mic size={16}/>} {muted ? 'Stumm' : 'Mikrofon an'}</span></div> : null}{voiceParticipants.filter(p => p.userId !== account.userId).map(peer => { const stream = remoteStreams[peer.userId]; const hasAudio = Boolean(stream?.getAudioTracks().some(track => track.readyState === 'live')); return <div className="voice-person" key={peer.userId}><Avatar name={peer.displayName || remoteNames[peer.userId] || 'Mitglied'}/><strong>{peer.displayName || remoteNames[peer.userId] || 'Mitglied'}</strong><span className="voice-speaking"><Volume2 size={15}/> {hasAudio ? 'Audio verbunden' : (isInVoice && voiceChannelId === activeChannel.id ? 'Verbindung wird aufgebaut' : 'Im Sprachkanal')}</span>{stream?.getVideoTracks().length ? <video className="screen-video" autoPlay muted playsInline ref={el => { if (el && stream) { if (el.srcObject !== stream) el.srcObject = stream; void el.play().catch(() => {}); } }}/> : null}{stream ? <audio autoPlay ref={el => { if (el) { if (el.srcObject !== stream) el.srcObject = stream; void el.play().catch(() => {}); } }}/> : null}</div>; })}{voiceParticipants.length === 0 && <div className="voice-empty"><Users size={28}/><span>{isInVoice && voiceChannelId === activeChannel.id ? 'Noch niemand sonst im Kanal' : 'Noch keine Mitglieder im Sprachkanal'}</span></div>}</div>{!isInVoice || voiceChannelId !== activeChannel.id ? <button className="primary voice-join" disabled={!connectionReady} onClick={() => startVoice(activeChannel)}><Phone size={18}/> Sprachchat beitreten</button> : <><div className="voice-controls"><button className={muted ? 'muted' : ''} onClick={toggleMute}>{muted ? <MicOff/> : <Mic/>}{muted ? 'Mikrofon an' : 'Stummschalten'}</button><button className={screenStream ? 'share-active' : ''} onClick={toggleScreenShare}>{screenStream ? <Video/> : <MonitorIcon/>}{screenStream ? 'Teilen beenden' : 'Bildschirm teilen'}</button><button className="danger" onClick={() => stopVoice()}><PhoneOff/> Verlassen</button></div>{screenStream && <video className="local-screen-preview" autoPlay muted playsInline ref={el => { if (el && screenStream && el.srcObject !== screenStream) el.srcObject = screenStream; }}/>}</>}<small className="voice-warning">Audio benötigt Mikrofonfreigabe. {turnAvailable ? 'TURN-Relay konfiguriert.' : 'STUN ist aktiv. Für restriktive Netzwerke können TURN-Zugangsdaten in der Serverkonfiguration hinterlegt werden.'}</small></section>
      : <><div className="chat-content"><div className="welcome-banner"><div className="welcome-icon">{mode === 'dm' ? <AtSign size={28}/> : <Hash size={28}/>}</div><div className="eyebrow">{mode === 'dm' ? 'DIREKTNACHRICHT' : (activeServer?.name || 'COMMUNITY')}</div><h2>{mode === 'dm' ? activeThread?.otherDisplayName || 'Direktnachricht' : 'Willkommen in #' + (activeChannel?.name || 'general')}</h2><p>{mode === 'dm' ? 'Das ist der Anfang eurer Unterhaltung.' : 'Das ist der Anfang dieses Kanals. Mach was Gutes draus. 🍞'}</p></div><div className="messages">{messageLoadError && <div className="message-load-error"><strong>Chat konnte nicht geladen werden</strong><span>{messageLoadError}</span><button type="button" onClick={reloadMessages}>Erneut laden</button></div>}{visibleMessages.map(m => <article className="message" key={m.id}><Avatar name={m.author} picture={m.authorPicture} size="large"/><div className="message-body"><div className="message-meta"><strong>{m.author}</strong>{m.authorBadges?.map(b => <span className="message-badge" key={b} title={b}>{({toast_legend:'🍞 Legende',golden_toast:'🥇 Gold',community_star:'⭐ Star',beta_tester:'🧪 Beta',vip_toast:'👑 VIP',pro_member:'👑 Pro'} as Record<string,string>)[b] || b.replace(/_/g,' ')}</span>)}<time>{new Date(m.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time>{m.editedAt && <span className="edited-tag">(bearbeitet)</span>}</div><p>{m.text}</p>{m.attachments?.length ? <AttachmentList attachments={m.attachments}/> : null}{m.reactions && Object.entries(m.reactions).filter(([, users]) => users.length).length > 0 && <div className="reaction-list">{Object.entries(m.reactions).filter(([, users]) => users.length).map(([emoji, users]) => <button key={emoji} className="reaction-chip" onClick={() => messageAction('react', m)}>{emoji} <span>{users.length}</span></button>)}</div>}</div><div className="message-actions"><button title={savedMessages.some(item=>item.id===m.id) ? 'Aus Merkliste entfernen' : 'Nachricht merken'} onClick={() => toggleSavedMessage(m)}><Bookmark size={15} fill={savedMessages.some(item=>item.id===m.id) ? 'currentColor' : 'none'}/></button><button title="Nachricht kopieren" onClick={() => { void navigator.clipboard.writeText(m.text).then(()=>toast('Nachricht kopiert.')).catch(()=>toast('Kopieren wurde vom Browser blockiert.')); }}><Copy size={15}/></button><button title="Toast-Reaktion" onClick={() => messageAction('react', m)}><Smile size={16}/></button>{m.authorId === account.userId && <><button title="Bearbeiten" onClick={() => messageAction('edit', m)}><Pencil size={15}/></button><button title="Löschen" onClick={() => messageAction('delete', m)}><Trash2 size={15}/></button></>}</div></article>)}{filter && visibleMessages.length === 0 && <div className="no-results"><Search size={22}/><strong>Keine Treffer</strong><span>In diesem geladenen Chat wurden keine passenden Nachrichten gefunden.</span></div>}</div></div>{pendingUploads.length > 0 && <div className="pending-uploads">{pendingUploads.map(file => <div className="pending-file" key={file.id}><Paperclip size={14}/><span>{file.name}</span><button type="button" title="Anhang entfernen" onClick={() => setPendingUploads(prev => prev.filter(f => f.id !== file.id))}><X size={14}/></button></div>)}</div>}<form className="composer" onSubmit={sendMessage}><input ref={fileInputRef} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/ogg,audio/wav,audio/webm,application/pdf,text/plain,application/zip,application/x-7z-compressed" onChange={uploadFiles}/><button type="button" className="composer-plus" title="Datei anhängen" onClick={() => fileInputRef.current?.click()}><Paperclip/></button><input value={draft} onChange={e => updateDraft(e.target.value)} placeholder={mode === 'dm' ? 'Nachricht an ' + (activeThread?.otherDisplayName || 'Mitglied') : 'Nachricht an #' + (activeChannel?.name || 'general')} aria-label="Nachricht" maxLength={2000}/><div className="composer-tools"><button type="button" title="Toast-Shop und Geschenke" onClick={() => setModal('shop')}><Gift/></button><button type="button" title="Emoji hinzufügen" onClick={() => setDraft(d => d + ' 🍞')}><Smile/></button><button className="send-button" type="submit" title="Senden" disabled={(!draft.trim() && pendingUploads.length === 0) || busy}><Send size={18}/></button></div></form></>}
    </main>

    {showMembers && <aside className="members"><div className="members-head">MITGLIEDER <span>{activeServer ? 'DER COMMUNITY' : ''}</span></div>{mode === 'channel' && activeServer ? <MembersPanel serverId={activeServer.id} onStartDM={startDM} currentUserId={account.userId} viewerRole={activeServer.role || 'member'} refreshKey={activeServer.id + ':' + serverMembersRevision}/> : <div className="member-tip">Wähle einen Server aus, um seine Mitglieder zu sehen.</div>}<div className="member-footer"><ShieldCheck size={15}/> Deine Direktnachrichten sind nur für die Beteiligten sichtbar.</div></aside>}

    {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice('')}><X size={16}/></button></div>}

    {modal && <div className="modal-backdrop" onClick={() => !busy && setModal(null)}><div className={modal === 'profile' || modal === 'settings' || modal === 'shop' || modal === 'admin' || modal === 'toastlab' ? 'modal extras-modal toastlab-modal' : 'modal'} onClick={e => e.stopPropagation()}><button className="modal-x" onClick={() => setModal(null)}><X/></button>
      {modal === 'server' && <><div className="modal-icon"><Server/></div><h2>Deinen Server erstellen</h2><p>Eine eigene Ecke für deine Leute, Projekte oder völlig übertrieben detaillierten Gaming-Pläne.</p><form onSubmit={createServer}><label>SERVERNAME</label><input autoFocus value={formText} onChange={e => setFormText(e.target.value)} placeholder="z. B. Toast Zone" maxLength={48}/><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary" disabled={!formText.trim() || busy}>{busy ? 'Erstelle …' : 'Server erstellen'}</button></div></form></>}
      {modal === 'channel' && <><div className="modal-icon"><Hash/></div><h2>Kanal erstellen</h2><p>Kanäle halten Gespräche nach Themen sortiert.</p><form onSubmit={createChannel}><label>KANALNAME</label><input autoFocus value={formText} onChange={e => setFormText(e.target.value)} placeholder="z. B. minecraft" maxLength={48}/><label className="label-spaced">KANALTYP</label><div className="segmented"><button type="button" className={newChannelKind === 'text' ? 'current' : ''} onClick={() => setNewChannelKind('text')}><Hash size={16}/> Text</button><button type="button" className={newChannelKind === 'voice' ? 'current' : ''} onClick={() => setNewChannelKind('voice')}><Volume2 size={16}/> Sprache</button></div><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary" disabled={!formText.trim() || busy}>Kanal erstellen</button></div></form></>}
      {modal === 'join' && <><div className="modal-icon"><Compass/></div><h2>Server beitreten</h2><p>Füge einen Einladungs-Code ein, den dir ein Servermitglied geschickt hat.</p><form onSubmit={joinServer}><label>EINLADUNGSCODE</label><input autoFocus value={formText} onChange={e => setFormText(e.target.value)} placeholder="z. B. TOASTZONE" maxLength={100}/><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Abbrechen</button><button className="primary" disabled={!formText.trim() || busy}>Beitreten</button></div></form></>}
      {modal === 'invite' && <><div className="modal-icon"><Link2/></div><h2>Freunde einladen</h2><p>Wer den Link öffnet und angemeldet ist, kann dem Server beitreten.</p><label>DEIN EINLADUNGSLINK</label><div className="invite-copy"><code>{window.location.origin}/?invite={inviteCode}</code><button onClick={copyInvite} title="Link kopieren"><Copy size={17}/></button></div><div className="invite-code">Code: <strong>{inviteCode}</strong></div><div className="modal-actions"><button onClick={() => setModal(null)}>Fertig</button><button className="primary" onClick={copyInvite}><Copy size={15}/> Link kopieren</button></div></>}
      {modal === 'toastlab' && <ToastLab accountId={account.userId} servers={servers} channels={channels} messages={messages} savedMessages={savedMessages} draft={draft} mode={mode} activeServerId={activeServer?.id || 'toast-zone'} activeChannelId={activeChannel?.id || ''} activeThreadId={activeThreadId} status={presenceStatus} onStatusChange={savePresence} onUpdateDraft={updateDraft} onToggleSaved={toggleSavedMessage} onOpenSaved={openSavedMessage} onSwitchChannel={channel => {setActiveServerId(channel.serverId);setActiveChannelId(channel.id);setMode('channel');setFilter('');setModal(null);}} onFocusMode={() => {setFocusMode(v=>!v);setShowMembers(focusMode);}} onClose={() => setModal(null)} onNotify={toast} />} {modal === 'dm' && <><div className="modal-icon"><UserPlus/></div><h2>Freunde finden</h2><p>Suche nach Mitgliedern deines aktuellen Servers, um eine private Unterhaltung zu öffnen.</p><div className="member-search"><Search size={18}/><input autoFocus value={memberQuery} onChange={e => setMemberQuery(e.target.value)} placeholder="Anzeigenamen suchen …"/></div><div className="search-results">{memberQuery.trim() && memberResults.filter(m => m.userId !== account.userId).map(m => <div className="search-result" key={m.userId}><Avatar name={m.displayName} picture={m.picture}/><div className="search-result-copy"><strong>{m.displayName}</strong><small><span className="online-dot"/> {m.status || 'Online'}</small></div><button disabled={busy} onClick={() => startDM(m)}><MessageCircle size={17}/> Nachricht</button></div>)}{memberQuery.trim() && memberResults.filter(m => m.userId !== account.userId).length === 0 && <div className="empty-search">Keine passenden Mitglieder gefunden.</div>}{!memberQuery.trim() && <div className="empty-search">Tippe mindestens ein paar Buchstaben ein.</div>}</div><div className="modal-actions"><button onClick={() => setModal(null)}>Schließen</button></div></>}
      {(modal === 'profile' || modal === 'settings' || modal === 'shop' || modal === 'admin') && <RewardsPanel initialTab={modal === 'profile' ? 'profile' : modal === 'settings' ? 'settings' : modal === 'shop' ? 'shop' : 'admin'} accountId={account.userId} profile={profile} rewards={rewards} onProfileUpdated={setProfile} onRewardsUpdated={setRewards} onNotify={toast}/>}
    </div></div>}
  </div>;
}

function MailIcon() { return <AtSign size={15}/>; }
function MonitorIcon() { return <Video size={18}/>; }

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const signature = attachments.map(a => a.id).join('|');
  useEffect(() => {
    let alive = true;
    Promise.all(attachments.map(async file => {
      try { const r = await api.get('/api/files/' + encodeURIComponent(file.id)); return [file.id, r.data.url] as const; }
      catch { return [file.id, ''] as const; }
    })).then(items => { if (alive) setUrls(Object.fromEntries(items.filter((item): item is readonly [string, string] => Boolean(item[1])))); });
    return () => { alive = false; };
  }, [signature]);
  return <div className="attachment-list">{attachments.map(file => <div className="attachment-card" key={file.id}><Paperclip size={18}/><span className="attachment-name"><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(0)} KB · {file.contentType}</small></span>{urls[file.id] ? <a href={urls[file.id]} target="_blank" rel="noreferrer" title="Datei öffnen"><ChevronRight size={18}/></a> : <span className="attachment-loading">Lädt …</span>}</div>)}</div>;
}

function MembersPanel({ serverId, onStartDM, currentUserId, viewerRole, refreshKey }: { serverId: string; onStartDM: (member: PublicMember) => void; currentUserId: string; viewerRole: string; refreshKey: string }) {
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [loadError, setLoadError] = useState('');
  const [bans, setBans] = useState<PublicMember[]>([]);
  const [expanded, setExpanded] = useState('');
  const [refresh, setRefresh] = useState(0);
  const canModerate = ['owner', 'admin', 'moderator'].includes(viewerRole);
  const canAdmin = ['owner', 'admin'].includes(viewerRole);
  const roleRank: Record<string, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
  async function load() {
    setLoadError('');
    try {
      const r = await api.get('/api/members', { serverId });
      setMembers(r.data.members || []);
    } catch (err: any) {
      setMembers([]);
      setLoadError(err?.response?.data?.error || 'Mitglieder konnten nicht geladen werden.');
    }
    if (canAdmin) { try { const r = await api.get('/api/servers/bans', { serverId }); setBans(r.data.bans || []); } catch { setBans([]); } }
  }
  useEffect(() => { void load(); }, [serverId, refreshKey, refresh, viewerRole]);
  async function manage(action: 'role' | 'kick' | 'ban' | 'unban', member: PublicMember, role?: string) {
    if (!window.confirm(action === 'kick' ? member.displayName + ' vom Server entfernen?' : action === 'ban' ? member.displayName + ' dauerhaft vom Server sperren?' : action === 'unban' ? member.displayName + ' entsperren?' : 'Rolle von ' + member.displayName + ' ändern?')) return;
    try {
      if (action === 'role') await api.put('/api/members/role', { serverId, userId: member.userId, role });
      if (action === 'kick') await api.post('/api/members/kick', { serverId, userId: member.userId });
      if (action === 'ban') await api.post('/api/members/ban', { serverId, userId: member.userId });
      if (action === 'unban') await api.post('/api/members/unban', { serverId, userId: member.userId });
      setRefresh(n => n + 1);
    } catch (err: any) { window.alert(err?.response?.data?.error || 'Moderationsaktion fehlgeschlagen. Prüfe deine Rechte.'); }
  }
  return <><div className="members-group">MITGLIEDER — {members.length}</div>{members.map(m => {
    const isSelf = m.userId === currentUserId;
    const canTouch = canModerate && !isSelf && m.role !== 'owner' && (viewerRole === 'owner' || roleRank[m.role || 'member'] < roleRank[viewerRole]);
    return <div key={m.userId} className="member-wrap"><button className="member-row" onClick={() => !isSelf && onStartDM(m)} title={isSelf ? 'Du' : 'Direktnachricht öffnen'}><Avatar name={m.displayName} picture={m.picture}/><span className="member-name"><strong>{m.displayName}{isSelf ? ' (Du)' : ''}</strong><small>{m.role || 'member'} · {m.status || 'online'}</small></span><span className="online-dot"/></button>{canTouch && <button className="member-moderate-toggle" title="Moderation" onClick={() => setExpanded(expanded === m.userId ? '' : m.userId)}><MoreHorizontal size={17}/></button>}{canTouch && expanded === m.userId && <div className="moderation-tools">{(viewerRole === 'owner' || (viewerRole === 'admin' && m.role !== 'admin')) && <select aria-label={'Rolle für ' + m.displayName} value={m.role || 'member'} onChange={e => void manage('role', m, e.target.value)}><option value="member">Mitglied</option><option value="moderator">Moderator</option>{viewerRole === 'owner' && <option value="admin">Admin</option>}</select>}<button onClick={() => void manage('kick', m)} title="Vom Server entfernen"><UserX size={14}/> Kick</button>{canAdmin && <button className="ban-action" onClick={() => void manage('ban', m)} title="Vom Server sperren"><Ban size={14}/> Ban</button>}</div>}</div>;
  })}{canAdmin && <><div className="members-group banned-heading">GESPERRT — {bans.length}</div>{bans.map(m => <div className="banned-row" key={m.userId}><span>{m.displayName}</span><button onClick={() => void manage('unban', m)}>Entsperren</button></div>)}</>}{members.length === 0 && (loadError ? <div className="member-error"><span>{loadError}</span><button onClick={() => setRefresh(n => n + 1)}>Erneut laden</button></div> : <div className="member-tip">Noch keine Mitglieder gefunden.</div>)}<div className="member-tip">Rollen und Moderationsaktionen sind serverseitig geprüft.</div></>;
}

export default App;