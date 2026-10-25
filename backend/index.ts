import { router, json, error, db, ws, requireAuth, storage, secrets, isAppDatabaseError } from '@appdeploy/sdk';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { addSubscription, removeSubscriptions, notifySubscribers } from './realtime-subscribers';

type Profile = { id: string; userId: string; displayName: string; email?: string; picture?: string; picturePath?: string; bannerPath?: string; status: string; createdAt: number; memberServerIds?: string[] };
type Server = { id: string; name: string; ownerId: string; inviteCode: string; createdAt: number; description?: string };
type Channel = { id: string; serverId: string; name: string; kind: 'text'|'voice'; createdAt: number };
type Membership = { id: string; serverId: string; userId: string; joinedAt: number; role?: 'owner' | 'admin' | 'moderator' | 'member' };
type FileAsset = { id: string; name: string; contentType: string; size: number; path: string; ownerId: string; channelId?: string; threadId?: string; createdAt: number };
type Attachment = { id: string; name: string; contentType: string; size: number };
type Ban = { id: string; serverId: string; userId: string; bannedBy: string; createdAt: number };
type Message = { id: string; channelId?: string; threadId?: string; authorId: string; author: string; text: string; createdAt: number; editedAt?: number; reactions?: Record<string,string[]>; deleted?: boolean; attachments?: Attachment[]; authorPicture?: string; authorBadges?: string[]; recordType?: string };
type Thread = { id: string; participants: string[]; createdAt: number };
type VoiceSession = { id: string; channelId: string; userId: string; displayName: string; connectionId: string; joinedAt: number; recordType?: string };
type MemberEntry = { userId: string; role: 'owner' | 'admin' | 'moderator' | 'member'; joinedAt: number };
type MemberIndex = { id: string; recordType: 'member_index'; serverId: string; members: MemberEntry[]; updatedAt: number };
type MessageIndex = { id: string; recordType: 'message_index'; scopeType: 'channel' | 'dm'; scopeId: string; messageIds: string[]; updatedAt: number };
type VoiceIndex = { id: string; recordType: 'voice_index'; channelId: string; sessionIds: string[]; updatedAt: number };
type RewardState = { id: string; userId: string; points: number; badges: string[]; gifts: Record<string, number>; ownedItems: string[]; proUntil: number; lastChatRewardAt: number; lastVoiceRewardAt: number; updatedAt?: number };
type AdminSession = { id: string; userId: string; expiresAt: number };
type AdminGate = { id: string; userId: string; badAttempts: number; lockedUntil: number };
type GiftCode = { id: string; code: string; rewardType: 'points'|'gift'|'badge'|'pro'; rewardValue: string; rewardAmount: number; createdBy: string; createdAt: number; expiresAt: number; maxUses: number; uses: number; active: boolean };
type GiftCodeRedemption = { id: string; userId: string; codeId: string; createdAt: number };

// Bounded retry for transient database read failures only. Writes are never blindly retried.
async function retryDatabaseRead<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      const retryable = isAppDatabaseError(err) &&
        (err.code === 'AppDatabaseGatewayUnavailable' || err.code === 'AppDatabaseReadIncomplete');
      if (!retryable || attempt >= 3) throw err;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      attempt += 1;
    }
  }
}

async function chosenAdd<T extends {id:string}>(table: string, record: T): Promise<T> {
  const [existing] = await db.get<T>(table, [record.id]);
  if (existing) return existing;
  const [created] = await db.tx.add(table, [record]);
  if (created) return record;
  const [saved] = await db.get<T>(table, [record.id]);
  if (saved) return saved;
  throw new Error('Database record could not be created');
}
async function profileFor(user: {userId:string; name?:string; email?:string; picture?:string}): Promise<Profile> {
  try {
    const [existing] = await db.get<Profile>('profiles', [user.userId]);
    if (existing) { await writeFallbackMember(existing); return existing; }
    const created = await chosenAdd('profiles', { id:user.userId, userId:user.userId, displayName:(user.name || user.email?.split('@')[0] || 'Toast-Nutzer').slice(0,32), email:user.email, picture:user.picture, status:'online', createdAt:Date.now() });
    await writeFallbackMember(created);
    return created;
  } catch (err) {
    if (!isAppDatabaseError(err) || err.code !== 'AppDatabaseGatewayUnavailable') throw err;
    const fallback:Profile = {id:user.userId,userId:user.userId,displayName:(user.name || user.email?.split('@')[0] || 'Toast-Nutzer').slice(0,32),email:user.email,picture:user.picture,status:'online',createdAt:Date.now(),memberServerIds:['toast-zone']};
    await writeFallbackMember(fallback);
    return fallback;
  }
}

async function configuredAdminCode(): Promise<string | null> {
  try {
    const names = await secrets.listSecretNames();
    if (!names.includes('ADMIN_CODE')) return null;
    const value = (await secrets.readSecret('ADMIN_CODE')).trim();
    return value || null;
  } catch { return null; }
}
const VALID_BADGES = ['toast_legend','golden_toast','community_star','beta_tester','vip_toast','pro_member'];
const SHOP_CATALOG: Record<string,{price:number;kind:'pro'|'badge'|'frame'|'gift';grant:string}> = {
  toast_pro:{price:3000,kind:'pro',grant:'pro_member'},
  badge_golden:{price:1000,kind:'badge',grant:'golden_toast'},
  frame_neon:{price:1600,kind:'frame',grant:'neon_frame'},
  gift_box:{price:250,kind:'gift',grant:'gift_box'}
};

async function decorateProfile(profile: Profile) {
  const {picturePath, bannerPath, ...visible} = profile;
  let picture = profile.picture;
  let banner: string | undefined;
  try {
    if (picturePath) { const [asset] = await storage.url([picturePath]); picture = asset?.url || picture; }
    if (bannerPath) { const [asset] = await storage.url([bannerPath]); banner = asset?.url; }
  } catch {}
  return {...visible, picture, banner};
}

async function rewardsFor(userId: string): Promise<RewardState> {
  const [existing] = await db.get<RewardState>('user_rewards',[userId]);
  if (existing) return {...existing, badges:existing.badges || [], gifts:existing.gifts || {}, ownedItems:existing.ownedItems || [], points:Math.max(0,Number(existing.points)||0), proUntil:Number(existing.proUntil)||0, lastChatRewardAt:Number(existing.lastChatRewardAt)||0, lastVoiceRewardAt:Number(existing.lastVoiceRewardAt)||0};
  return chosenAdd<RewardState>('user_rewards',{id:userId,userId,points:0,badges:[],gifts:{},ownedItems:[],proUntil:0,lastChatRewardAt:0,lastVoiceRewardAt:0,updatedAt:Date.now()});
}

async function patchRewards(userId: string, patch: Partial<RewardState>): Promise<RewardState> {
  const current = await rewardsFor(userId);
  const next: RewardState = {...current,...patch,id:userId,userId,updatedAt:Date.now()};
  const [ok] = await db.tx.update('user_rewards',[{id:userId,record:next,if:{userId}}],{patch:true});
  if (!ok) throw new Error('Reward wallet update failed');
  return next;
}

function walletView(state: RewardState) {
  const isPro = state.proUntil > Date.now();
  return {points:state.points,badges:state.badges || [],gifts:state.gifts || {},ownedItems:state.ownedItems || [],proUntil:state.proUntil,isPro,maxUploadBytes:isPro ? 20*1024*1024 : 10*1024*1024};
}

async function rewardChat(userId: string, text: string) {
  const current = await rewardsFor(userId);
  const now = Date.now();
  let earned = 0;
  if (text.trim().length >= 8 && now - current.lastChatRewardAt >= 30000) {
    await patchRewards(userId,{points:current.points+5,lastChatRewardAt:now});
    earned = 5;
  }
  return {wallet:walletView(await rewardsFor(userId)),earned};
}

async function hasAdminAccess(userId: string) {
  const [session] = await db.get<AdminSession>('admin_sessions',['admin-'+userId]);
  return Boolean(session && session.expiresAt > Date.now());
}

async function decorateMessages(messages: Message[]) {
  if (!messages.length) return messages;
  const ids = [...new Set(messages.map(m => m.authorId))];
  let profiles: Array<Profile | null> = [];
  try { profiles = await db.get<Profile>('profiles', ids); } catch (err) { console.warn('Could not decorate message profiles', err); }
  const byId = new Map(profiles.filter((p): p is Profile => Boolean(p)).map(p => [p.userId, p]));
  return Promise.all(messages.map(async message => {
    const profile = byId.get(message.authorId);
    let picture = profile?.picture;
    let badges: string[] = [];
    if (profile) {
      try { picture = (await decorateProfile(profile)).picture; } catch {}
    }
    // Cosmetic profile metadata must never make a persisted message unreadable.
    try { badges = (await rewardsFor(message.authorId)).badges || []; } catch (err) { console.warn('Could not load message badges', err); }
    return { ...message, authorPicture: picture, authorBadges: badges };
  }));
}
async function ensureDefaults() {
  await chosenAdd<Server>('servers', { id:'toast-zone', name:'Toast Zone', ownerId:'system', inviteCode:'TOASTZONE', description:'Der offizielle Startpunkt für deine Toastcord-Community.', createdAt:0 });
  const defaultChannels: Channel[] = [
    {id:'ch-general',serverId:'toast-zone',name:'general',kind:'text',createdAt:0},
    {id:'ch-announcements',serverId:'toast-zone',name:'ankündigungen',kind:'text',createdAt:1},
    {id:'ch-clips',serverId:'toast-zone',name:'clips-und-highlights',kind:'text',createdAt:2},
    {id:'ch-minecraft',serverId:'toast-zone',name:'minecraft',kind:'text',createdAt:3},
    {id:'ch-voice-lobby',serverId:'toast-zone',name:'Lobby',kind:'voice',createdAt:4}
  ];
  for (const c of defaultChannels) await chosenAdd('channels', c);
}
function memberIndexId(serverId:string) {
  return stableStoreKey('memberidx-', serverId);
}
async function getMemberIndex(serverId:string): Promise<MemberIndex|null> {
  const [index] = await retryDatabaseRead(() => db.get<MemberIndex>('servers',[memberIndexId(serverId)]));
  return index?.recordType === 'member_index' ? index : null;
}
async function upsertMemberIndex(serverId:string,userId:string,role:MemberEntry['role'],joinedAt=Date.now()) {
  const id = memberIndexId(serverId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const index = await getMemberIndex(serverId);
    const now = Date.now();
    const members = [...(index?.members || []).filter(m => m.userId !== userId), {userId,role,joinedAt}].slice(-1000);
    if (!index) {
      const [created] = await db.tx.add('servers',[{id,recordType:'member_index',serverId,members,updatedAt:now}]);
      if (created) break;
      continue;
    }
    const [updated] = await db.tx.update('servers',[{id,record:{members,updatedAt:now},if:{recordType:'member_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) break;
    if (attempt === 5) throw new Error('Mitgliederindex konnte nicht aktualisiert werden');
  }
  // Keep a user-to-server shortcut for recovery if the legacy membership catalog is unavailable.
  try {
    const [profile] = await db.get<Profile>('profiles',[userId]);
    if (profile && !(profile.memberServerIds || []).includes(serverId)) {
      await db.tx.update('profiles',[{id:userId,record:{memberServerIds:[...(profile.memberServerIds || []),serverId].slice(-100)},if:{userId}}],{patch:true});
    }
  } catch (err) { console.warn('Member shortcut update failed', err); }
}
async function removeMemberFromIndex(serverId:string,userId:string) {
  const id = memberIndexId(serverId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const index = await getMemberIndex(serverId);
    if (!index) return;
    const members = index.members.filter(m => m.userId !== userId);
    const [updated] = await db.tx.update('servers',[{id,record:{members,updatedAt:Date.now()},if:{recordType:'member_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) break;
  }
  try {
    const [profile] = await db.get<Profile>('profiles',[userId]);
    if (profile?.memberServerIds?.includes(serverId)) await db.tx.update('profiles',[{id:userId,record:{memberServerIds:profile.memberServerIds.filter(id => id !== serverId)},if:{userId}}],{patch:true});
  } catch {}
}
async function ensureMembership(serverId:string,userId:string): Promise<Membership> {
  const id = 'm-' + serverId + '-' + userId;
  const index = await getMemberIndex(serverId);
  const indexed = index?.members.find(m => m.userId === userId);
  if (indexed) return {id,serverId,userId,joinedAt:indexed.joinedAt,role:indexed.role};
  let server: Server | null = null;
  try { const [found] = await db.get<Server>('servers',[serverId]); server = found || null; } catch {}
  let existing: Membership | null = null;
  try { const [found] = await db.get<Membership>('memberships',[id],{consistent:true}); existing = found || null; } catch {}
  const role: MemberEntry['role'] = existing?.role || (server?.ownerId === userId ? 'owner' : 'member');
  const membership: Membership = {id,serverId,userId,joinedAt:existing?.joinedAt || Date.now(),role};
  await upsertMemberIndex(serverId,userId,role,membership.joinedAt);
  try {
    if (existing) {
      if (!existing.role) await db.tx.update('memberships',[{id,record:{role},if:{userId}}],{patch:true});
    } else {
      await chosenAdd<Membership>('memberships',membership);
    }
  } catch (err) { console.warn('Legacy membership mirror unavailable', err); }
  try { await notifySubscribers('server-members', serverId, {action:'joined',userId}); } catch {}
  return membership;
}
async function isMember(serverId:string,userId:string) {
  if (!serverId || !userId) return false;
  if (serverId === 'toast-zone') return true;
  try {
    const [server] = await retryDatabaseRead(() => db.get<Server>('servers',[serverId]));
    if (server?.ownerId === userId) return true;
  } catch {}
  try {
    const index = await getMemberIndex(serverId);
    if (index?.members.some(m => m.userId === userId)) return true;
  } catch {}
  try {
    const [direct] = await db.get<Membership>('memberships',['m-' + serverId + '-' + userId],{consistent:true});
    return Boolean(direct);
  } catch { return false; }
}
async function membershipFor(serverId:string,userId:string): Promise<Membership|null> {
  try {
    const index = await getMemberIndex(serverId);
    const member = index?.members.find(m => m.userId === userId);
    if (member) return {id:'m-' + serverId + '-' + userId,serverId,userId,joinedAt:member.joinedAt,role:member.role};
  } catch {}
  try {
    const [direct] = await db.get<Membership>('memberships',['m-' + serverId + '-' + userId],{consistent:true});
    if (direct) return direct;
  } catch {}
  try {
    const [server] = await db.get<Server>('servers',[serverId]);
    if (server?.ownerId === userId) return {id:'m-' + serverId + '-' + userId,serverId,userId,joinedAt:server.createdAt,role:'owner'};
  } catch {}
  if (serverId === 'toast-zone') return {id:'m-toast-zone-' + userId,serverId,userId,joinedAt:0,role:'member'};
  return null;
}
const roleRank: Record<string,number> = { member:0, moderator:1, admin:2, owner:3 };
async function resolveAttachments(ids: unknown, userId: string, context: {channelId?:string;threadId?:string}): Promise<Attachment[] | null> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 5 || ids.some(id => typeof id !== 'string')) return null;
  const unique = [...new Set(ids as string[])];
  if (!unique.length) return [];
  const records = await db.get<FileAsset>('file_assets', unique);
  if (records.some(file => !file || file.ownerId !== userId || file.channelId !== context.channelId || file.threadId !== context.threadId)) return null;
  return (records as FileAsset[]).map(file => ({id:file.id,name:file.name,contentType:file.contentType,size:file.size}));
}
async function getChannelForMember(channelId:string,userId:string) {
  try {
    const [channel] = await retryDatabaseRead(() => db.get<Channel>('channels',[channelId]));
    if (!channel || !(await isMember(channel.serverId,userId))) return null;
    return channel;
  } catch (err) {
    if (!isAppDatabaseError(err) || err.code !== 'AppDatabaseGatewayUnavailable') throw err;
    return FALLBACK_CHANNELS.find(channel=>channel.id===channelId) || null;
  }
}
async function requireThread(threadId:string,userId:string) {
  const [thread] = await db.get<Thread>('dm_threads',[threadId]);
  return thread && thread.participants.includes(userId) ? thread : null;
}
async function getPublicProfile(userId:string): Promise<Profile|null> {
  const [p] = await db.get<Profile>('profiles',[userId]);
  return p || null;
}
function stableStoreKey(prefix:string, ...parts:string[]) {
  return prefix + createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0,40);
}

type FallbackMember = { userId:string; displayName:string; status:string; picture?:string; role:string; joinedAt:number };
type FallbackVoiceSession = { id:string; recordType:'voice_session'; channelId:string; userId:string; displayName:string; connectionId:string; joinedAt:number };
type FallbackWsClient = { id:string; recordType:'ws_client'; connectionId:string; userId:string; createdAt:number; voiceChannels?:string[]; subscriptionIds?:string[] };
const FALLBACK_MEMBER_PATH = 'toastcord-fallback/members-toast-zone.json';
const FALLBACK_CHANNELS: Channel[] = [
  {id:'ch-general',serverId:'toast-zone',name:'general',kind:'text',createdAt:0},
  {id:'ch-announcements',serverId:'toast-zone',name:'ankündigungen',kind:'text',createdAt:1},
  {id:'ch-clips',serverId:'toast-zone',name:'clips-und-highlights',kind:'text',createdAt:2},
  {id:'ch-minecraft',serverId:'toast-zone',name:'minecraft',kind:'text',createdAt:3},
  {id:'ch-voice-lobby',serverId:'toast-zone',name:'Lobby',kind:'voice',createdAt:4}
];
async function readFallbackJson<T>(path:string, fallback:T): Promise<T> {
  try { const [entry] = await storage.read([path]); return entry?.content ? JSON.parse(entry.content) as T : fallback; }
  catch { return fallback; }
}
async function writeFallbackJson(path:string, value:unknown): Promise<void> {
  const [ok] = await storage.write([{path,content:JSON.stringify(value),contentType:'application/json'}]);
  if (!ok) throw new Error('Fallback storage write failed');
}
function fallbackMessagePath(field:'channelId'|'threadId',value:string) {
  return 'toastcord-fallback/messages-' + createHash('sha256').update(field+':'+value).digest('hex').slice(0,40) + '.json';
}
async function readFallbackMessages(field:'channelId'|'threadId',value:string): Promise<Message[]> {
  const rows = await readFallbackJson<Message[]>(fallbackMessagePath(field,value),[]);
  return Array.isArray(rows) ? rows.filter(m=>m && m[field]===value && !m.deleted).sort((a,b)=>a.createdAt-b.createdAt).slice(-100) : [];
}
async function mergeMessages(primary:Message[],field:'channelId'|'threadId',value:string): Promise<Message[]> {
  const all = new Map<string,Message>();
  for (const m of primary) if (m && m[field]===value && !m.deleted) all.set(m.id,m);
  for (const m of await readFallbackMessages(field,value)) all.set(m.id,m);
  return [...all.values()].sort((a,b)=>a.createdAt-b.createdAt).slice(-100);
}
async function writeFallbackMessage(message:Message): Promise<void> {
  const field = message.channelId ? 'channelId' : 'threadId';
  const value = message.channelId || message.threadId || '';
  if (!value) throw new Error('Fallback message has no destination');
  const rows = await readFallbackMessages(field,value);
  await writeFallbackJson(fallbackMessagePath(field,value),[...rows.filter(m=>m.id!==message.id),message].sort((a,b)=>a.createdAt-b.createdAt).slice(-100));
}
async function readFallbackMembers(): Promise<FallbackMember[]> {
  const rows = await readFallbackJson<FallbackMember[]>(FALLBACK_MEMBER_PATH,[]);
  return Array.isArray(rows) ? rows.filter(m=>m && typeof m.userId==='string').slice(-1000) : [];
}
async function writeFallbackMember(profile:Profile): Promise<void> {
  try {
    const rows = await readFallbackMembers();
    const m:FallbackMember = {userId:profile.userId,displayName:profile.displayName || 'Toast-Nutzer',status:profile.status || 'online',picture:profile.picture,role:'member',joinedAt:Date.now()};
    await writeFallbackJson(FALLBACK_MEMBER_PATH,[...rows.filter(x=>x.userId!==m.userId),m].slice(-1000));
  } catch (err) { console.warn('Fallback member index could not be saved',String(err)); }
}
function fallbackVoicePath(channelId:string) { return 'toastcord-fallback/voice-'+createHash('sha256').update(channelId).digest('hex').slice(0,40)+'.json'; }
async function readFallbackVoiceSessions(channelId:string): Promise<FallbackVoiceSession[]> {
  const rows = await readFallbackJson<FallbackVoiceSession[]>(fallbackVoicePath(channelId),[]);
  return Array.isArray(rows) ? rows.filter(s=>s && s.recordType==='voice_session' && s.channelId===channelId && !!s.connectionId).slice(-100) : [];
}
async function writeFallbackVoiceSession(session:VoiceSession): Promise<void> {
  const rows=await readFallbackVoiceSessions(session.channelId);
  const stored:FallbackVoiceSession = {...session,recordType:'voice_session'};
  await writeFallbackJson(fallbackVoicePath(session.channelId),[...rows.filter(s=>s.userId!==stored.userId),stored].slice(-100));
}
async function removeFallbackVoiceSession(channelId:string,userId:string): Promise<void> {
  const rows=await readFallbackVoiceSessions(channelId);
  await writeFallbackJson(fallbackVoicePath(channelId),rows.filter(s=>s.userId!==userId));
}
function fallbackWsPath(connectionId:string) { return 'toastcord-fallback/ws-'+createHash('sha256').update(connectionId).digest('hex').slice(0,40)+'.json'; }
async function readFallbackWsClient(connectionId:string): Promise<FallbackWsClient|null> { return readFallbackJson<FallbackWsClient|null>(fallbackWsPath(connectionId),null); }
async function writeFallbackWsClient(client:FallbackWsClient): Promise<void> { await writeFallbackJson(fallbackWsPath(client.connectionId),client); }

function voiceSessionRecordId(channelId:string,userId:string) {
  return stableStoreKey('voice-',channelId,userId);
}
function wsClientRecordId(connectionId:string) {
  return stableStoreKey('ws-',connectionId);
}
async function listServerChannels(): Promise<Channel[]> {
  const channels: Channel[] = [];
  let nextToken: string | undefined;
  for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
    const page = await retryDatabaseRead(() => db.list<Channel>('channels',{limit:1000,nextToken}));
    channels.push(...page.items.filter(c => typeof c.serverId === 'string' && (c.kind === 'text' || c.kind === 'voice')));
    if (!page.nextToken) break;
    nextToken = page.nextToken;
  }
  return channels;
}
function messageIndexId(scopeType:'channel'|'dm',scopeId:string) {
  return stableStoreKey('msgidx-',scopeType,scopeId);
}
async function appendMessageToIndex(message:Message) {
  const scopeType = message.channelId ? 'channel' : 'dm';
  const scopeId = message.channelId || message.threadId || '';
  if (!scopeId) throw new Error('Nachricht hat kein Chat-Ziel');
  const id = messageIndexId(scopeType,scopeId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const [index] = await retryDatabaseRead(() => db.get<MessageIndex>('channels',[id]));
    const now = Date.now();
    const messageIds = [...(index?.recordType === 'message_index' ? index.messageIds : []).filter(mid => mid !== message.id),message.id].slice(-100);
    if (!index || index.recordType !== 'message_index') {
      const [created] = await db.tx.add('channels',[{id,recordType:'message_index',scopeType,scopeId,messageIds,updatedAt:now}]);
      if (created) return;
      continue;
    }
    const [updated] = await db.tx.update('channels',[{id,record:{messageIds,updatedAt:now},if:{recordType:'message_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) return;
  }
  throw new Error('Nachrichtenindex konnte nicht aktualisiert werden');
}
async function removeMessageFromIndex(message:Message) {
  const scopeType = message.channelId ? 'channel' : 'dm';
  const scopeId = message.channelId || message.threadId || '';
  if (!scopeId) return;
  const id = messageIndexId(scopeType,scopeId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [index] = await retryDatabaseRead(() => db.get<MessageIndex>('channels',[id]));
    if (!index || index.recordType !== 'message_index') return;
    const [updated] = await db.tx.update('channels',[{id,record:{messageIds:index.messageIds.filter(mid => mid !== message.id),updatedAt:Date.now()},if:{recordType:'message_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) return;
  }
}
async function listMessages(table:'channel_messages'|'dm_messages', field:'channelId'|'threadId', value:string) {
  const scopeType=field==='channelId'?'channel':'dm';
  const id=messageIndexId(scopeType,value);
  try {
    const [index]=await retryDatabaseRead(()=>db.get<MessageIndex>('channels',[id]));
    if(index?.recordType==='message_index'&&index.scopeId===value) {
      const records=index.messageIds.length?await retryDatabaseRead(()=>db.get<Message>('channels',index.messageIds)):[];
      return await mergeMessages(records.filter((m):m is Message=>Boolean(m&&m.recordType==='message'&&m[field]===value&&!m.deleted)),field,value);
    }
    try {
      const legacy=await db.list<Message>(table,{limit:1000});
      const messages=legacy.items.filter(m=>m[field]===value&&!m.deleted);
      for(const message of messages) {
        try { await chosenAdd('channels',{...message,recordType:'message'}); await appendMessageToIndex({...message,recordType:'message'}); }
        catch(err) { console.warn('Legacy message migration skipped',err); }
      }
      return await mergeMessages(messages.sort((a,b)=>a.createdAt-b.createdAt).slice(-100),field,value);
    } catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      return readFallbackMessages(field,value);
    }
  } catch(err) {
    if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
    return readFallbackMessages(field,value);
  }
}
async function getStoredMessage(messageId:string): Promise<Message|null> {
  const [message] = await retryDatabaseRead(() => db.get<Message>('channels',[messageId]));
  return message?.recordType === 'message' ? message : null;
}
function voiceIndexId(channelId:string) {
  return stableStoreKey('voiceidx-',channelId);
}
async function listVoiceSessions(channelId:string): Promise<VoiceSession[]> {
  try {
    const [index] = await retryDatabaseRead(() => db.get<VoiceIndex>('servers',[voiceIndexId(channelId)]));
    if (!index || index.recordType !== 'voice_index') return [];
    const sessions = index.sessionIds.length ? await retryDatabaseRead(() => db.get<VoiceSession>('servers',index.sessionIds)) : [];
    return sessions.filter((s): s is VoiceSession => Boolean(s && s.recordType === 'voice_session' && s.channelId === channelId && s.connectionId));
  } catch(err) {
    if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
    return readFallbackVoiceSessions(channelId);
  }
}
async function addVoiceSessionToIndex(session:VoiceSession) {
  const id = voiceIndexId(session.channelId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const [index] = await retryDatabaseRead(() => db.get<VoiceIndex>('servers',[id]));
    const now = Date.now();
    const sessionIds = [...(index?.recordType === 'voice_index' ? index.sessionIds : []).filter(sid => sid !== session.id),session.id].slice(-100);
    if (!index || index.recordType !== 'voice_index') {
      const [created] = await db.tx.add('servers',[{id,recordType:'voice_index',channelId:session.channelId,sessionIds,updatedAt:now}]);
      if (created) return;
      continue;
    }
    const [updated] = await db.tx.update('servers',[{id,record:{sessionIds,updatedAt:now},if:{recordType:'voice_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) return;
  }
  throw new Error('Sprachindex konnte nicht aktualisiert werden');
}
async function removeVoiceSessionFromIndex(channelId:string,userId:string) {
  const id = voiceIndexId(channelId);
  const sessionId = voiceSessionRecordId(channelId,userId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [index] = await retryDatabaseRead(() => db.get<VoiceIndex>('servers',[id]));
    if (!index || index.recordType !== 'voice_index') return;
    const [updated] = await db.tx.update('servers',[{id,record:{sessionIds:index.sessionIds.filter(sid => sid !== sessionId),updatedAt:Date.now()},if:{recordType:'voice_index',updatedAt:index.updatedAt}}],{patch:true});
    if (updated) return;
  }
}
async function getVoiceSession(channelId:string,userId:string): Promise<VoiceSession|null> {
  try {
    const [session] = await retryDatabaseRead(() => db.get<VoiceSession>('servers',[voiceSessionRecordId(channelId,userId)]));
    return session?.recordType === 'voice_session' ? session : null;
  } catch(err) {
    if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
    return (await readFallbackVoiceSessions(channelId)).find(s=>s.userId===userId)||null;
  }
}
async function getWsClient(connectionId:string): Promise<{id:string;userId:string;recordType?:string;voiceChannels?:string[];subscriptionIds?:string[]}|null> {
  try {
    const [client] = await retryDatabaseRead(() => db.get<{id:string;userId:string;recordType?:string;voiceChannels?:string[];subscriptionIds?:string[]}>('servers',[wsClientRecordId(connectionId)]));
    return client?.recordType === 'ws_client' ? client : null;
  } catch(err) {
    if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
    return readFallbackWsClient(connectionId);
  }
}
async function broadcastVoice(channelId:string,type:string,payload:Record<string,unknown>,excludeUserId?:string) {
  const items = await listVoiceSessions(channelId);
  const targets = items.filter(s=>s.userId!==excludeUserId && s.connectionId).map(s=>s.connectionId);
  if (targets.length) await ws.send([...new Set(targets)],{v:1,type,payload:{...payload,channelId}});
}

function authRoutes() {
 return {
  'GET /api/bootstrap': [requireAuth(), async ({user}) => {
    try {
      const u = user!;
      await ensureDefaults();
      const me = await profileFor(u);
      await writeFallbackMember(me);
      await ensureMembership('toast-zone',u.userId);
      let memberships: Membership[] = [];
      try {
        const page = await db.list<Membership>('memberships',{limit:1000});
        memberships = page.items;
      } catch (err) {
        if (!isAppDatabaseError(err) || err.code !== 'AppDatabaseGatewayUnavailable') throw err;
        const [freshProfile] = await db.get<Profile>('profiles',[u.userId]);
        const ids = [...new Set(['toast-zone',...(freshProfile?.memberServerIds || [])])];
        memberships = (await Promise.all(ids.map(id => membershipFor(id,u.userId)))).filter((m):m is Membership=>Boolean(m));
      }
      const mine = memberships.filter(m=>m.userId===u.userId);
      // Rebuild compact per-server indexes in one pass from the legacy membership catalog when available.
      const grouped = new Map<string,MemberEntry[]>();
      for (const m of memberships) {
        const list = grouped.get(m.serverId) || [];
        list.push({userId:m.userId,role:m.role || 'member',joinedAt:m.joinedAt || Date.now()});
        grouped.set(m.serverId,list);
      }
      for (const [serverId,entries] of grouped) {
        try {
          const id = memberIndexId(serverId);
          const [old] = await db.get<MemberIndex>('servers',[id]);
          const merged = new Map<string,MemberEntry>((old?.recordType === 'member_index' ? old.members : []).map(m=>[m.userId,m]));
          for (const entry of entries) merged.set(entry.userId,entry);
          const index: MemberIndex = {id,recordType:'member_index',serverId,members:Array.from(merged.values()).slice(-1000),updatedAt:Date.now()};
          if (old?.recordType === 'member_index') await db.tx.update('servers',[{id,record:index,if:{recordType:'member_index',updatedAt:old.updatedAt}}],{patch:true});
          else await db.tx.add('servers',[index]);
        } catch (err) { console.warn('Member index migration skipped',err); }
      }
      const serverIds = [...new Set(mine.map(m=>m.serverId))];
      const servers = (await db.get<Server>('servers',serverIds)).filter((s):s is Server=>!!s).map(s=>({...s,role:mine.find(m=>m.serverId===s.id)?.role || 'member'}));
      const allChannels = await listServerChannels();
      const channels = allChannels.filter(c=>serverIds.includes(c.serverId));
      const {items: allThreads} = await db.list<Thread>('dm_threads',{limit:1000});
      const mineThreads = allThreads.filter(t=>t.participants.includes(u.userId));
      const threads = await Promise.all(mineThreads.map(async t=>{
        const otherId = t.participants.find(id=>id!==u.userId) || '';
        const other = await getPublicProfile(otherId);
        return {...t,otherUserId:otherId,otherDisplayName:other?.displayName || 'Mitglied'};
      }));
      return json({me:await decorateProfile(me),servers,channels,threads,wallet:walletView(await rewardsFor(u.userId))});
    } catch (e) {
      if(!isAppDatabaseError(e)||e.code!=='AppDatabaseGatewayUnavailable')return error('Toastcord konnte nicht initialisiert werden',500);
      const me=await profileFor(user!);
      const wallet=walletView({id:user!.userId,userId:user!.userId,points:0,badges:[],gifts:{},ownedItems:[],proUntil:0,lastChatRewardAt:0,lastVoiceRewardAt:0});
      return json({me:await decorateProfile(me),servers:[{id:'toast-zone',name:'Toast Zone',ownerId:'system',inviteCode:'TOASTZONE',description:'Der offizielle Startpunkt für deine Toastcord-Community.',createdAt:0,role:'member'}],channels:FALLBACK_CHANNELS,threads:[],wallet,degraded:true});
    }
  }],
  'GET /api/channels': [requireAuth(), async ({user,query})=>{
    const serverId = query.serverId || '';
    if (!serverId || !(await isMember(serverId,user!.userId))) return error('Kein Zugriff auf diesen Server',403);
    const items = await listServerChannels();
    return json({channels:items.filter(c=>c.serverId===serverId)});
  }],
  'POST /api/servers': [requireAuth(), async ({user,body})=>{
    const input = body as {name?:string};
    const name=(input?.name||'').trim().slice(0,48);
    if (!name) return error('Servername fehlt',400);
    const server:Server={id:crypto.randomUUID(),name,ownerId:user!.userId,inviteCode:crypto.randomUUID().replace(/-/g,'').slice(0,10).toUpperCase(),createdAt:Date.now()};
    await chosenAdd('servers',server);
    await ensureMembership(server.id,user!.userId);
    const general:Channel={id:crypto.randomUUID(),serverId:server.id,name:'general',kind:'text',createdAt:Date.now()};
    const voice:Channel={id:crypto.randomUUID(),serverId:server.id,name:'Sprachlobby',kind:'voice',createdAt:Date.now()+1};
    await chosenAdd('channels',general); await chosenAdd('channels',voice);
    return json({server,channels:[general,voice]});
  }],
  'POST /api/servers/join': [requireAuth(), async ({user,body})=>{
    await ensureDefaults();
    const code=((body as {inviteCode?:string})?.inviteCode||'').trim().toUpperCase();
    if (!code) return error('Einladungscode fehlt',400);
    const {items} = await db.list<Server>('servers',{limit:1000});
    const server=items.find(s=>s.inviteCode===code);
    if (!server) return error('Einladung ungültig',404);
    const [ban] = await db.get<Ban>('server_bans',['ban-'+server.id+'-'+user!.userId]);
    if (ban) return error('Du bist von diesem Server gesperrt',403);
    await ensureMembership(server.id,user!.userId);
    const allChannels = await listServerChannels();
    return json({server,channels:allChannels.filter(c=>c.serverId===server.id)});
  }],
  'POST /api/servers/invite': [requireAuth(), async ({user,body})=>{
    const serverId=(body as {serverId?:string})?.serverId||'';
    if (!(await isMember(serverId,user!.userId))) return error('Kein Zugriff auf diesen Server',403);
    const [server]=await db.get<Server>('servers',[serverId]);
    if (!server) return error('Server nicht gefunden',404);
    const inviteCode=server.inviteCode || crypto.randomUUID().replace(/-/g,'').slice(0,10).toUpperCase();
    return json({inviteCode});
  }],
  'POST /api/channels': [requireAuth(), async ({user,body})=>{
    const input=body as {serverId?:string;name?:string;kind?:'text'|'voice'};
    const serverId=input?.serverId||'', name=(input?.name||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,48);
    const kind=input?.kind==='voice'?'voice':'text';
    if (!name) return error('Kanalname fehlt',400);
    if (!(await isMember(serverId,user!.userId))) return error('Kein Zugriff auf diesen Server',403);
    const items = await listServerChannels();
    if(items.some(c=>c.serverId===serverId && c.name===name))return error('Dieser Kanalname existiert bereits',409);
    const channel:Channel={id:crypto.randomUUID(),serverId,name,kind,createdAt:Date.now()};
    await chosenAdd('channels',channel);
    return json({channel});
  }],
  'POST /api/files': [requireAuth(), async ({user,body})=>{
    const input=body as {name?:string;contentType?:string;size?:number;base64?:string;channelId?:string;threadId?:string};
    const rawName=(input?.name||'Datei').split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120) || 'Datei';
    const name=rawName==='.'||rawName==='..'?'Datei':rawName;
    const contentType=input?.contentType||'';
    const size=Number(input?.size||0);
    const base64=input?.base64||'';
    const allowed=['image/png','image/jpeg','image/gif','image/webp','video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav','audio/webm','application/pdf','text/plain','application/zip','application/x-7z-compressed'];
    if(!allowed.includes(contentType))return error('Dieser Dateityp ist nicht erlaubt',415);
    const uploadWallet=await rewardsFor(user!.userId);
    const maxFileBytes=uploadWallet.proUntil>Date.now()?20*1024*1024:10*1024*1024;
    if(!Number.isFinite(size)||size<1||size>maxFileBytes||!base64||base64.length>maxFileBytes*1.4)return error('Dateigröße überschritten. Dein Limit beträgt '+Math.round(maxFileBytes/1024/1024)+' MB.',413);
    const channelId=input?.channelId||undefined, threadId=input?.threadId||undefined;
    if(Boolean(channelId)===Boolean(threadId))return error('Wähle genau einen Chat als Ziel',400);
    if(channelId){const channel=await getChannelForMember(channelId,user!.userId);if(!channel||channel.kind!=='text')return error('Textkanal nicht verfügbar',403);}
    if(threadId && !(await requireThread(threadId,user!.userId)))return error('Direktnachricht nicht verfügbar',403);
    const id=crypto.randomUUID();
    const path='uploads/'+user!.userId+'/'+id+'/'+name;
    const [stored]=await storage.write([{path,content:base64,contentType}]);
    if(!stored)return error('Datei konnte nicht gespeichert werden',500);
    const file:FileAsset={id,name,contentType,size,path,ownerId:user!.userId,channelId,threadId,createdAt:Date.now()};
    try { await chosenAdd('file_assets',file); } catch { await storage.delete([path]); return error('Dateimetadaten konnten nicht gespeichert werden',500); }
    return json({attachment:{id,name,contentType,size}});
  }],
  'GET /api/files/:id': [requireAuth(), async ({user,params})=>{
    const [file]=await db.get<FileAsset>('file_assets',[params.id]);
    if(!file)return error('Datei nicht gefunden',404);
    if(file.channelId && !(await getChannelForMember(file.channelId,user!.userId)))return error('Kein Zugriff auf diese Datei',403);
    if(file.threadId && !(await requireThread(file.threadId,user!.userId)))return error('Kein Zugriff auf diese Datei',403);
    const [signed]=await storage.url([file.path]);
    if(!signed?.url)return error('Download-Link konnte nicht erstellt werden',500);
    return json({url:signed.url,name:file.name,contentType:file.contentType,size:file.size});
  }],
  'GET /api/rewards/me': [requireAuth(), async ({user})=>{
    const me=await profileFor(user!);
    return json({me:await decorateProfile(me),wallet:walletView(await rewardsFor(user!.userId))});
  }],
  'POST /api/rewards/voice-tick': [requireAuth(), async ({user,body})=>{
    const channelId=(body as {channelId?:string})?.channelId||'';
    const session = await getVoiceSession(channelId,user!.userId);
    if(!session)return error('Du bist in keinem bestätigten Sprachkanal',403);
    const current=await rewardsFor(user!.userId);
    const now=Date.now();
    if(now-session.joinedAt<55000 || now-current.lastVoiceRewardAt<55000)return json({wallet:walletView(current),pointsEarned:0});
    const updated=await patchRewards(user!.userId,{points:current.points+10,lastVoiceRewardAt:now});
    return json({wallet:walletView(updated),pointsEarned:10});
  }],
  'GET /api/admin/status': [requireAuth(), async ({user})=>json({unlocked:await hasAdminAccess(user!.userId)})],
  'POST /api/admin/unlock': [requireAuth(), async ({user,body})=>{
    const code=((body as {code?:string})?.code||'').trim();
    const now=Date.now();
    const [gate]=await db.get<AdminGate>('admin_gates',[user!.userId]);
    if(gate && gate.lockedUntil>now)return error('Zu viele Versuche. Warte 15 Minuten, bevor du es erneut versuchst.',429);
    const adminCode = await configuredAdminCode();
    if(!adminCode || code!==adminCode){
      const attempts=(gate?.badAttempts||0)+1;
      const next:AdminGate={id:user!.userId,userId:user!.userId,badAttempts:attempts,lockedUntil:attempts>=5?now+15*60*1000:0};
      if(gate)await db.tx.update('admin_gates',[{id:user!.userId,record:next,if:{userId:user!.userId}}],{patch:true}); else await chosenAdd('admin_gates',next);
      return error(attempts>=5?'Zu viele falsche Codes. Admin-Zugang 15 Minuten gesperrt.':'Admin-Code falsch.',403);
    }
    const session:AdminSession={id:'admin-'+user!.userId,userId:user!.userId,expiresAt:now+60*60*1000};
    const [old]=await db.get<AdminSession>('admin_sessions',[session.id]);
    if(old)await db.tx.update('admin_sessions',[{id:session.id,record:session,if:{userId:user!.userId}}],{patch:true}); else await chosenAdd('admin_sessions',session);
    if(gate)await db.tx.update('admin_gates',[{id:user!.userId,record:{badAttempts:0,lockedUntil:0},if:{userId:user!.userId}}],{patch:true});
    return json({ok:true,expiresAt:session.expiresAt});
  }],
  'GET /api/admin/users': [requireAuth(), async ({user,query})=>{
    if(!(await hasAdminAccess(user!.userId)))return error('Admin-Zugriff erforderlich',403);
    const q=(query.q||'').toLocaleLowerCase().trim();
    const {items}=await db.list<Profile>('profiles',{limit:1000});
    const matching=items.filter(p=>!q || p.displayName.toLocaleLowerCase().includes(q) || (p.email||'').toLocaleLowerCase().includes(q) || p.userId.toLocaleLowerCase().includes(q)).slice(0,40);
    const users=await Promise.all(matching.map(async p=>{const hydrated=await decorateProfile(p);const w=await rewardsFor(p.userId);return {userId:p.userId,displayName:p.displayName,email:p.email,picture:hydrated.picture,points:w.points,badges:w.badges,gifts:w.gifts,proUntil:w.proUntil};}));
    return json({users});
  }],
  'GET /api/admin/codes': [requireAuth(), async ({user})=>{
    if(!(await hasAdminAccess(user!.userId)))return error('Admin-Zugriff erforderlich',403);
    const {items}=await db.list<GiftCode>('gift_codes',{limit:100});
    return json({codes:items.sort((a,b)=>b.createdAt-a.createdAt)});
  }],
  'POST /api/admin/codes': [requireAuth(), async ({user,body})=>{
    if(!(await hasAdminAccess(user!.userId)))return error('Admin-Zugriff erforderlich',403);
    const input=body as {rewardType?:string;rewardValue?:string;amount?:number;maxUses?:number;expiresInDays?:number};
    const rewardType=input.rewardType||'', rewardValue=(input.rewardValue||'').trim();
    const amount=Math.trunc(Number(input.amount||0));
    const maxUses=Math.trunc(Number(input.maxUses||0));
    const expiresInDays=Math.trunc(Number(input.expiresInDays||0));
    if(!['points','gift','badge','pro'].includes(rewardType))return error('Unbekannter Belohnungstyp',400);
    if(!Number.isFinite(maxUses)||maxUses<1||maxUses>5000)return error('Maximale Einlösungen müssen zwischen 1 und 5000 liegen',400);
    if(!Number.isFinite(expiresInDays)||expiresInDays<0||expiresInDays>365)return error('Gültigkeit muss zwischen 0 und 365 Tagen liegen',400);
    if(rewardType==='points'&&(!Number.isFinite(amount)||amount<1||amount>1000000))return error('Punkte müssen zwischen 1 und 1.000.000 liegen',400);
    if(rewardType==='pro'&&(!Number.isFinite(amount)||amount<1||amount>365))return error('Pro-Tage müssen zwischen 1 und 365 liegen',400);
    if(rewardType==='gift'&&!['gift_box','gift_bouquet'].includes(rewardValue))return error('Unbekanntes Geschenk',400);
    if(rewardType==='badge'&&!VALID_BADGES.includes(rewardValue))return error('Unbekanntes Abzeichen',400);
    const normalizedRewardValue=rewardType==='points'?'points':rewardType==='pro'?'days':rewardValue;
    let record:GiftCode|null=null;
    for(let attempt=0;attempt<4&&!record;attempt++){
      const code='TOAST-'+randomBytes(6).toString('hex').toUpperCase();
      const id=code.replace(/[^A-Z0-9]/g,'');
      const [existing]=await db.get<GiftCode>('gift_codes',[id]);
      if(existing)continue;
      record={id,code,rewardType:rewardType as GiftCode['rewardType'],rewardValue:normalizedRewardValue,rewardAmount:rewardType==='gift'||rewardType==='badge'?1:amount,createdBy:user!.userId,createdAt:Date.now(),expiresAt:expiresInDays===0?0:Date.now()+expiresInDays*24*60*60*1000,maxUses,uses:0,active:true};
    }
    if(!record)return error('Es konnte kein eindeutiger Code erzeugt werden. Bitte erneut versuchen.',500);
    const [created]=await db.tx.add('gift_codes',[record]);
    if(!created)return error('Code konnte nicht gespeichert werden. Bitte erneut versuchen.',409);
    return json({code:record});
  }],
  'POST /api/admin/codes/:id/deactivate': [requireAuth(), async ({user,params})=>{
    if(!(await hasAdminAccess(user!.userId)))return error('Admin-Zugriff erforderlich',403);
    const [code]=await db.get<GiftCode>('gift_codes',[params.id],{consistent:true});
    if(!code)return error('Code nicht gefunden',404);
    if(!code.active)return json({ok:true,active:false});
    const [ok]=await db.tx.update('gift_codes',[{id:params.id,record:{active:false},if:{active:true}}],{patch:true});
    if(!ok)return error('Code konnte nicht deaktiviert werden. Bitte erneut laden.',409);
    return json({ok:true,active:false});
  }],
  'POST /api/rewards/redeem': [requireAuth(), async ({user,body})=>{
    const raw=((body as {code?:string})?.code||'').trim().toUpperCase();
    const id=raw.replace(/[^A-Z0-9]/g,'');
    if(id.length<8||id.length>40)return error('Gib einen gültigen Einlösecode ein',400);
    const [code]=await db.get<GiftCode>('gift_codes',[id],{consistent:true});
    if(!code||!code.active)return error('Dieser Code ist ungültig oder wurde deaktiviert',404);
    const now=Date.now();
    if(code.expiresAt&&code.expiresAt<=now)return error('Dieser Code ist abgelaufen',410);
    if(code.uses>=code.maxUses)return error('Alle Einlösungen für diesen Code wurden bereits verbraucht',409);
    const redemptionId='redeem-'+code.id+'-'+user!.userId;
    const [prior]=await db.get<GiftCodeRedemption>('gift_code_redemptions',[redemptionId],{consistent:true});
    if(prior)return error('Du hast diesen Code bereits eingelöst',409);
    const current=await rewardsFor(user!.userId);
    let points=current.points, badges=[...current.badges], gifts={...current.gifts}, ownedItems=[...current.ownedItems], proUntil=current.proUntil;
    let message='Code eingelöst.';
    if(code.rewardType==='points'){
      points=Math.min(1000000000,points+code.rewardAmount);
      message='+'+code.rewardAmount.toLocaleString('de-DE')+' Toast-Punkte erhalten!';
    }else if(code.rewardType==='gift'){
      gifts[code.rewardValue]=(gifts[code.rewardValue]||0)+1;
      message=code.rewardValue==='gift_bouquet'?'Du hast ein Toast-Blumen-Geschenk erhalten!':'Du hast eine Geschenkbox erhalten!';
    }else if(code.rewardType==='badge'){
      if(badges.includes(code.rewardValue))return error('Dieses Abzeichen hast du bereits. Der Code wurde nicht verbraucht.',409);
      badges.push(code.rewardValue);
      message='Abzeichen freigeschaltet: '+code.rewardValue.replace(/_/g,' ')+'.';
    }else if(code.rewardType==='pro'){
      proUntil=Math.max(now,proUntil)+code.rewardAmount*24*60*60*1000;
      if(!badges.includes('pro_member'))badges.push('pro_member');
      message='Toastcord Pro für '+code.rewardAmount+' Tage freigeschaltet!';
    }
    const redemption:GiftCodeRedemption={id:redemptionId,userId:user!.userId,codeId:code.id,createdAt:now};
    const redeemWrite=db.tx.add('gift_code_redemptions',[redemption]);
    const codeWrite=db.tx.update('gift_codes',[{id:code.id,record:{uses:code.uses+1},if:{uses:code.uses,active:true}}],{patch:true});
    const walletWrite=db.tx.update('user_rewards',[{id:user!.userId,record:{points,badges,gifts,ownedItems,proUntil},if:{userId:user!.userId}}],{patch:true});
    try{
      await db.transact([redeemWrite,codeWrite,walletWrite]);
    }catch(err){
      if(isAppDatabaseError(err)&&['AppDatabaseConditionFailed','AppDatabaseConflict','AppDatabaseDuplicateId'].includes(err.code)){
        const [already]=await db.get<GiftCodeRedemption>('gift_code_redemptions',[redemptionId],{consistent:true});
        if(already)return error('Du hast diesen Code bereits eingelöst',409);
        return error('Der Code wurde möglicherweise gerade ausgeschöpft. Lade die Codes neu und versuche es erneut.',409);
      }
      throw err;
    }
    return json({ok:true,message,wallet:walletView(await rewardsFor(user!.userId))});
  }],
  'POST /api/admin/action': [requireAuth(), async ({user,body})=>{
    if(!(await hasAdminAccess(user!.userId)))return error('Admin-Zugriff erforderlich',403);
    const input=body as {targetUserId?:string;action?:string;amount?:number;badgeId?:string;giftId?:string;months?:number;displayName?:string};
    const targetId=(input.targetUserId||'').trim(), action=input.action||'';
    if(!targetId)return error('Wähle ein Zielkonto aus',400);
    const [target]=await db.get<Profile>('profiles',[targetId]);
    if(!target)return error('Konto nicht gefunden',404);
    const current=await rewardsFor(targetId);
    if(action==='points'){
      const amount=Number(input.amount||0);
      if(!Number.isFinite(amount)||Math.abs(amount)>100000||amount===0)return error('Punktebetrag muss zwischen -100000 und 100000 liegen',400);
      await patchRewards(targetId,{points:Math.max(0,Math.min(1000000000,current.points+Math.trunc(amount)))});
    }else if(action==='badge'){
      const badge=input.badgeId||'';
      if(!VALID_BADGES.includes(badge))return error('Unbekanntes Abzeichen',400);
      if(!current.badges.includes(badge))await patchRewards(targetId,{badges:[...current.badges,badge]});
    }else if(action==='remove_badge'){
      const badge=input.badgeId||'';
      await patchRewards(targetId,{badges:current.badges.filter(b=>b!==badge)});
    }else if(action==='gift'){
      const gift=input.giftId||'';
      if(!['gift_box','gift_bouquet'].includes(gift))return error('Unbekanntes Geschenk',400);
      await patchRewards(targetId,{gifts:{...current.gifts,[gift]:(current.gifts[gift]||0)+1}});
    }else if(action==='pro'){
      const months=Math.trunc(Number(input.months||1));
      if(months<1||months>12)return error('Monate müssen zwischen 1 und 12 liegen',400);
      const base=Math.max(Date.now(),current.proUntil);
      await patchRewards(targetId,{proUntil:base+months*30*24*60*60*1000,badges:current.badges.includes('pro_member')?current.badges:[...current.badges,'pro_member']});
    }else if(action==='remove_pro'){
      await patchRewards(targetId,{proUntil:0,badges:current.badges.filter(b=>b!=='pro_member')});
    }else if(action==='set_name'){
      const displayName=(input.displayName||'').trim().slice(0,32);
      if(!displayName)return error('Anzeigename fehlt',400);
      const [ok]=await db.tx.update('profiles',[{id:targetId,record:{displayName},if:{userId:targetId}}],{patch:true});
      if(!ok)return error('Anzeigename konnte nicht gespeichert werden',409);
    }else return error('Unbekannte Admin-Aktion',400);
    const updated=await rewardsFor(targetId);
    return json({ok:true,message:'Aktion ausgeführt für '+target.displayName+'.',user:{userId:targetId,displayName:target.displayName,points:updated.points,badges:updated.badges,proUntil:updated.proUntil}});
  }],
  'POST /api/shop/buy': [requireAuth(), async ({user,body})=>{
    const itemId=(body as {itemId?:string})?.itemId||'';
    const item=SHOP_CATALOG[itemId];
    if(!item)return error('Dieses Shop-Item gibt es nicht',404);
    const current=await rewardsFor(user!.userId);
    if(current.points<item.price)return error('Dafür hast du nicht genug Toast-Punkte',400);
    if(item.kind==='badge'&&current.badges.includes(item.grant))return error('Dieses Abzeichen hast du bereits',409);
    if(item.kind==='frame'&&current.ownedItems.includes(item.grant))return error('Dieses Profil-Extra hast du bereits',409);
    const patch:Partial<RewardState>={points:current.points-item.price};
    if(item.kind==='pro'){
      patch.proUntil=Math.max(Date.now(),current.proUntil)+30*24*60*60*1000;
      patch.badges=current.badges.includes('pro_member')?current.badges:[...current.badges,'pro_member'];
    }else if(item.kind==='badge')patch.badges=[...current.badges,item.grant];
    else if(item.kind==='frame')patch.ownedItems=[...current.ownedItems,item.grant];
    else patch.gifts={...current.gifts,[item.grant]:(current.gifts[item.grant]||0)+1};
    const updated=await patchRewards(user!.userId,patch);
    return json({wallet:walletView(updated),message:item.kind==='pro'?'Toastcord Pro wurde für 30 Tage verlängert.':'Kauf erfolgreich: '+itemId+'.'});
  }],
  'GET /api/voice/config': [requireAuth(), async ({user}) => {
    try {
      const names=await secrets.listSecretNames();
      if(names.includes('TURN_URLS')&&names.includes('TURN_USERNAME')&&names.includes('TURN_CREDENTIAL')){
        const urls=(await secrets.readSecret('TURN_URLS')).split(',').map(s=>s.trim()).filter(Boolean);
        const identity=await secrets.readSecret('TURN_USERNAME');
        const sharedSecret=await secrets.readSecret('TURN_CREDENTIAL');
        if(urls.length&&identity&&sharedSecret){
          const expiry=Math.floor(Date.now()/1000)+600;
          const username=expiry+':'+identity+'-'+user!.userId;
          const credential=createHmac('sha1',sharedSecret).update(username).digest('base64');
          return json({turnConfigured:true,iceServers:[{urls:['stun:stun.l.google.com:19302']},{urls,username,credential}]});
        }
      }
    } catch {}
    return json({turnConfigured:false,iceServers:[{urls:['stun:stun.l.google.com:19302']},{urls:['stun:stun1.l.google.com:19302']}]});
  }],
  'GET /api/messages': [requireAuth(), async ({user,query})=>{
    const channelId=(query.channelId||'');
    const channel=await getChannelForMember(channelId,user!.userId);
    if (!channel) return error('Kanal nicht gefunden oder kein Zugriff',403);
    return json({messages:await decorateMessages(await listMessages('channel_messages','channelId',channelId))});
  }],
  'POST /api/messages': [requireAuth(), async ({user,body})=>{
    const input=body as {channelId?:string;text?:string;attachments?:unknown};
    const channelId=input?.channelId||'', text=(input?.text||'').trim().slice(0,2000);
    const attachments=await resolveAttachments(input?.attachments,user!.userId,{channelId});
    if(attachments===null)return error('Ungültiger Anhang oder kein Zugriff',403);
    if (!text && attachments.length===0) return error('Nachricht darf nicht leer sein',400);
    const channel=await getChannelForMember(channelId,user!.userId);
    if (!channel || channel.kind!=='text') return error('Kanal nicht gefunden oder kein Textkanal',403);
    const me=await profileFor(user!);
    const message:Message={id:'msg-'+crypto.randomUUID(),channelId,authorId:user!.userId,author:me.displayName,text,createdAt:Date.now(),reactions:{},attachments,recordType:'message'};
    try {
      await chosenAdd('channels',message);
      await appendMessageToIndex(message);
    } catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      await writeFallbackMessage(message);
    }
    const liveMessage=(await decorateMessages([message]))[0];
    await notifySubscribers('channel',channelId,liveMessage);
    let wallet: ReturnType<typeof walletView> | undefined;
    let pointsEarned = 0;
    try { const reward=await rewardChat(user!.userId,text); wallet=reward.wallet; pointsEarned=reward.earned; }
    catch (err) { console.warn('Message reward skipped after successful send',err); }
    return json({message:liveMessage,...(wallet ? {wallet,pointsEarned} : {})});
  }],
  'PUT /api/messages/:id': [requireAuth(), async ({user,body,params})=>{
    const input=body as {text?:string}; const text=(input?.text||'').trim().slice(0,2000);
    const message=await getStoredMessage(params.id);
    if (!message || message.authorId!==user!.userId || !message.channelId) return error('Nachricht nicht gefunden oder nicht deine Nachricht',403);
    if (!text) return error('Nachricht darf nicht leer sein',400);
    const [ok]=await db.tx.update('channels',[{id:params.id,record:{text,editedAt:Date.now()},if:{authorId:user!.userId,recordType:'message',channelId:message.channelId}}],{patch:true});
    if (!ok) return error('Änderung konnte nicht gespeichert werden',409);
    const updated=await getStoredMessage(params.id);
    if (updated?.channelId) await notifySubscribers('channel',updated.channelId,updated);
    return json({message:updated});
  }],
  'DELETE /api/messages/:id': [requireAuth(), async ({user,params})=>{
    const message=await getStoredMessage(params.id);
    if (!message || message.authorId!==user!.userId || !message.channelId) return error('Nachricht nicht gefunden oder nicht deine Nachricht',403);
    await db.delete('channels',[params.id]);
    await removeMessageFromIndex(message);
    await notifySubscribers('channel',message.channelId||'',{id:params.id,channelId:message.channelId,deleted:true});
    return json({ok:true});
  }],
  'POST /api/messages/:id/reaction': [requireAuth(), async ({user,params,body})=>{
    const emoji=((body as {emoji?:string})?.emoji||'🍞').slice(0,12);
    const message=await getStoredMessage(params.id);
    if (!message || !message.channelId || !(await getChannelForMember(message.channelId,user!.userId))) return error('Nachricht nicht gefunden',404);
    const reactions={...(message.reactions||{})}; const voters=[...(reactions[emoji]||[])];
    reactions[emoji]=voters.includes(user!.userId)?voters.filter(id=>id!==user!.userId):[...voters,user!.userId];
    const [ok]=await db.tx.update('channels',[{id:params.id,record:{reactions},if:{channelId:message.channelId,recordType:'message'}}],{patch:true});
    if(!ok)return error('Reaktion konnte nicht gespeichert werden',409);
    const updated=await getStoredMessage(params.id);
    await notifySubscribers('channel',message.channelId,updated);
    return json({message:updated});
  }],
  'GET /api/members': [requireAuth(), async ({user,query})=>{
   try {
    const serverId=query.serverId||'';
    if (serverId === 'toast-zone') await ensureMembership(serverId,user!.userId);
    else {
      const [server] = await retryDatabaseRead(() => db.get<Server>('servers',[serverId]));
      if (server?.ownerId === user!.userId) await ensureMembership(serverId,user!.userId);
    }
    if (!(await isMember(serverId,user!.userId))) return error('Kein Zugriff auf Mitglieder dieses Servers',403);
    let memberEntries = (await getMemberIndex(serverId))?.members || [];
    const ownMembership = await membershipFor(serverId,user!.userId);
    if (ownMembership && !memberEntries.some(m=>m.userId===user!.userId)) {
      memberEntries = [...memberEntries,{userId:user!.userId,role:ownMembership.role || 'member',joinedAt:ownMembership.joinedAt}];
      await upsertMemberIndex(serverId,user!.userId,ownMembership.role || 'member',ownMembership.joinedAt);
    }
    // A best-effort migration keeps existing members visible while old membership records are phased out.
    try {
      const legacy = await db.list<Membership>('memberships',{limit:1000});
      const merged = new Map(memberEntries.map(m=>[m.userId,m]));
      for (const m of legacy.items.filter(m=>m.serverId===serverId)) merged.set(m.userId,{userId:m.userId,role:m.role || 'member',joinedAt:m.joinedAt || Date.now()});
      memberEntries = Array.from(merged.values()).slice(-1000);
    } catch (err) { if (!isAppDatabaseError(err) || err.code !== 'AppDatabaseGatewayUnavailable') console.warn('Legacy member scan failed',err); }
    const memberships: Membership[] = memberEntries.map(m=>({id:'m-'+serverId+'-'+m.userId,serverId,userId:m.userId,joinedAt:m.joinedAt,role:m.role}));
    const unique=[...new Set(memberships.map(m=>m.userId))].slice(0,100);
    const profileRecords=unique.length?await db.get<Profile>('profiles',unique):[];
    const profiles=profileRecords.filter((p):p is Profile=>!!p);
    const ownProfile=await profileFor(user!);
    if(!profiles.some(p=>p.userId===user!.userId))profiles.push(ownProfile);
    const q=(query.q||'').toLocaleLowerCase();
    const matching=profiles.filter(p=>memberships.some(m=>m.userId===p.userId)&&(!q||p.displayName.toLocaleLowerCase().includes(q))).slice(0,100);
    if(!matching.some(p=>p.userId===user!.userId)&&(!q||ownProfile.displayName.toLocaleLowerCase().includes(q)))matching.unshift(ownProfile);
    return json({members:await Promise.all(matching.map(async p=>{
      let picture=p.picture; let badges:string[]=[];
      try{picture=(await decorateProfile(p)).picture;}catch{}
      try{badges=(await rewardsFor(p.userId)).badges||[];}catch{}
      return {userId:p.userId,displayName:p.displayName,status:p.status,picture,badges,role:memberships.find(m=>m.serverId===serverId&&m.userId===p.userId)?.role||'member'};
    }))});
   } catch(err) {
    if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
    const serverId=query.serverId||'toast-zone';
    if(serverId!=='toast-zone')return json({members:[],degraded:true});
    const me=await profileFor(user!);
    await writeFallbackMember(me);
    const q=(query.q||'').toLocaleLowerCase();
    const fallback=await readFallbackMembers();
    if(!fallback.some(m=>m.userId===user!.userId))fallback.unshift({userId:user!.userId,displayName:me.displayName,status:me.status,picture:me.picture,role:'member',joinedAt:Date.now()});
    return json({members:fallback.filter(m=>!q||m.displayName.toLocaleLowerCase().includes(q)).slice(0,100),degraded:true});
   }
  }],
  'GET /api/servers/bans': [requireAuth(), async ({user,query})=>{
    const serverId=query.serverId||'';
    const actor=await membershipFor(serverId,user!.userId);
    if(!actor||!['owner','admin'].includes(actor.role||'member'))return error('Nur Admins oder Serverbesitzer dürfen Sperren verwalten',403);
    const {items}=await db.list<Ban>('server_bans',{limit:1000});
    const banned=items.filter(b=>b.serverId===serverId);
    const profiles=await db.get<Profile>('profiles',banned.map(b=>b.userId));
    return json({bans:banned.map((b,i)=>({userId:b.userId,displayName:profiles[i]?.displayName||'Unbekanntes Mitglied',role:'banned'}))});
  }],
  'PUT /api/members/role': [requireAuth(), async ({user,body})=>{
    const input=body as {serverId?:string;userId?:string;role?:string};
    const serverId=input.serverId||'', targetId=input.userId||'', role=input.role||'';
    if(!['member','moderator','admin'].includes(role))return error('Ungültige Rolle',400);
    const actor=await membershipFor(serverId,user!.userId), target=await membershipFor(serverId,targetId);
    if(!actor||!target||!['owner','admin'].includes(actor.role||'member'))return error('Keine Berechtigung für Rollenänderungen',403);
    if(target.role==='owner'||targetId===user!.userId)return error('Der Serverbesitzer oder das eigene Konto kann hier nicht geändert werden',403);
    if(actor.role==='admin'&&(target.role==='admin'||target.role==='owner'||role==='admin'))return error('Admins dürfen keine Admin-Rollen vergeben oder andere Admins ändern',403);
    await upsertMemberIndex(serverId,targetId,role as MemberEntry['role'],target.joinedAt);
    try { await db.tx.update('memberships',[{id:target.id,record:{role},if:{userId:targetId,serverId}}],{patch:true}); } catch (err) { console.warn('Legacy role mirror update failed',err); }
    try { await notifySubscribers('server-members', serverId, { action: 'updated', userId: targetId }); } catch (err) { console.warn('Member role update event failed', err); }
    return json({ok:true,role});
  }],
  'POST /api/members/kick': [requireAuth(), async ({user,body})=>{
    const input=body as {serverId?:string;userId?:string};
    const serverId=input.serverId||'', targetId=input.userId||'';
    const actor=await membershipFor(serverId,user!.userId), target=await membershipFor(serverId,targetId);
    if(!actor||!target||!['owner','admin','moderator'].includes(actor.role||'member'))return error('Keine Berechtigung zum Entfernen',403);
    if(targetId===user!.userId||target.role==='owner'||roleRank[actor.role||'member']<=roleRank[target.role||'member'])return error('Du kannst dieses Mitglied nicht entfernen',403);
    try { await db.delete('memberships',[target.id]); } catch (err) { console.warn('Legacy member deletion failed',err); }
    await removeMemberFromIndex(serverId,targetId);
    try { await notifySubscribers('server-members', serverId, { action: 'left', userId: targetId }); } catch (err) { console.warn('Member kick event failed', err); }
    return json({ok:true});
  }],
  'POST /api/members/ban': [requireAuth(), async ({user,body})=>{
    const input=body as {serverId?:string;userId?:string};
    const serverId=input.serverId||'', targetId=input.userId||'';
    const actor=await membershipFor(serverId,user!.userId), target=await membershipFor(serverId,targetId);
    if(!actor||!['owner','admin'].includes(actor.role||'member'))return error('Nur Admins oder Serverbesitzer dürfen sperren',403);
    if(targetId===user!.userId||target?.role==='owner'||(actor.role==='admin'&&target?.role==='admin'))return error('Dieses Mitglied darf nicht gesperrt werden',403);
    await chosenAdd<Ban>('server_bans',{id:'ban-'+serverId+'-'+targetId,serverId,userId:targetId,bannedBy:user!.userId,createdAt:Date.now()});
    if(target) { try { await db.delete('memberships',[target.id]); } catch (err) { console.warn('Legacy banned member deletion failed',err); } }
    await removeMemberFromIndex(serverId,targetId);
    try { await notifySubscribers('server-members', serverId, { action: 'left', userId: targetId }); } catch (err) { console.warn('Member ban event failed', err); }
    return json({ok:true});
  }],
  'POST /api/members/unban': [requireAuth(), async ({user,body})=>{
    const input=body as {serverId?:string;userId?:string};
    const serverId=input.serverId||'', targetId=input.userId||'';
    const actor=await membershipFor(serverId,user!.userId);
    if(!actor||!['owner','admin'].includes(actor.role||'member'))return error('Keine Berechtigung zum Entsperren',403);
    const [ban]=await db.get<Ban>('server_bans',['ban-'+serverId+'-'+targetId]);
    if(ban)await db.delete('server_bans',[ban.id]);
    try { await notifySubscribers('server-members', serverId, { action: 'unbanned', userId: targetId }); } catch (err) { console.warn('Member unban event failed', err); }
    return json({ok:true});
  }],
  'PUT /api/profile/status': [requireAuth(), async ({user,body})=>{
    const status=((body as {status?:string})?.status || '').trim();
    if (!['online','away','dnd','offline'].includes(status)) return error('Ungültiger Status',400);
    await profileFor(user!);
    const [ok] = await db.tx.update('profiles',[{id:user!.userId,record:{status},if:{userId:user!.userId}}],{patch:true});
    if (!ok) return error('Status konnte nicht gespeichert werden',409);
    const [updated] = await db.get<Profile>('profiles',[user!.userId]);
    return json({status:updated?.status || status});
  }],
  'POST /api/profile/assets': [requireAuth(), async ({user,body})=>{
    const input=body as {slot?:string;name?:string;contentType?:string;size?:number;base64?:string};
    const slot=input.slot==='banner'?'banner':input.slot==='picture'?'picture':'';
    const contentType=input.contentType||'';
    const size=Number(input.size||0);
    const base64=input.base64||'';
    const limit=slot==='banner'?4*1024*1024:2*1024*1024;
    if(!slot)return error('Ungültiger Profilbereich',400);
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(contentType))return error('Nur PNG, JPG, WebP oder GIF sind erlaubt',415);
    if(!Number.isFinite(size)||size<1||size>limit||!base64||base64.length>limit*1.4)return error('Bilddatei ist zu groß',413);
    const me=await profileFor(user!);
    const path='profiles/'+user!.userId+'/'+slot+'/'+crypto.randomUUID();
    const [stored]=await storage.write([{path,content:base64,contentType}]);
    if(!stored)return error('Bild konnte nicht gespeichert werden',500);
    const field=slot==='picture'?'picturePath':'bannerPath';
    const oldPath=slot==='picture'?me.picturePath:me.bannerPath;
    const [ok]=await db.tx.update('profiles',[{id:user!.userId,record:{[field]:path},if:{userId:user!.userId}}],{patch:true});
    if(!ok){await storage.delete([path]);return error('Profil konnte nicht aktualisiert werden',409);}
    if(oldPath)try{await storage.delete([oldPath]);}catch{}
    const [updated]=await db.get<Profile>('profiles',[user!.userId]);
    return json({me:await decorateProfile(updated||me)});
  }],
  'PUT /api/profile': [requireAuth(), async ({user,body})=>{
    const displayName=((body as {displayName?:string})?.displayName||'').trim().slice(0,32);
    if(!displayName)return error('Anzeigename fehlt',400);
    await profileFor(user!);
    const [ok]=await db.tx.update('profiles',[{id:user!.userId,record:{displayName},if:{userId:user!.userId}}],{patch:true});
    if(!ok)return error('Profil konnte nicht aktualisiert werden',409);
    const [me]=await db.get<Profile>('profiles',[user!.userId]);
    return json({me:await decorateProfile(me||await profileFor(user!))});
  }],
  'GET /api/dms': [requireAuth(), async ({user})=>{
    const {items}=await db.list<Thread>('dm_threads',{limit:1000});
    const mine=items.filter(t=>t.participants.includes(user!.userId));
    const threads=await Promise.all(mine.map(async t=>{
      const otherId=t.participants.find(id=>id!==user!.userId)||'';
      const other=await getPublicProfile(otherId);
      return {...t,otherUserId:otherId,otherDisplayName:other?.displayName||'Mitglied'};
    }));
    return json({threads});
  }],
  'POST /api/dms/create': [requireAuth(), async ({user,body})=>{
    const recipientId=(body as {recipientId?:string})?.recipientId||'';
    if(!recipientId||recipientId===user!.userId)return error('Ungültiger Empfänger',400);
    const {items: memberships}=await db.list<Membership>('memberships',{limit:1000});
    const mine=new Set(memberships.filter(m=>m.userId===user!.userId).map(m=>m.serverId));
    const common=memberships.some(m=>m.userId===recipientId && mine.has(m.serverId));
    if(!common)return error('Ihr braucht einen gemeinsamen Server',403);
    const [recipient]=await db.get<Profile>('profiles',[recipientId]);
    if(!recipient)return error('Mitglied nicht gefunden',404);
    const participants=[user!.userId,recipientId].sort();
    const id='dm-'+participants.join('-');
    const thread=await chosenAdd<Thread>('dm_threads',{id,participants,createdAt:Date.now()});
    return json({thread:{...thread,otherUserId:recipientId,otherDisplayName:recipient.displayName}});
  }],
  'GET /api/dm/messages': [requireAuth(), async ({user,query})=>{
    const threadId=query.threadId||'';
    if(!(await requireThread(threadId,user!.userId)))return error('Direktnachricht nicht gefunden',403);
    return json({messages:await decorateMessages(await listMessages('dm_messages','threadId',threadId))});
  }],
  'POST /api/dm/messages': [requireAuth(), async ({user,body})=>{
    const input=body as {threadId?:string;text?:string;attachments?:unknown};
    const threadId=input?.threadId||'', text=(input?.text||'').trim().slice(0,2000);
    const attachments=await resolveAttachments(input?.attachments,user!.userId,{threadId});
    if(attachments===null)return error('Ungültiger Anhang oder kein Zugriff',403);
    if(!text&&attachments.length===0)return error('Nachricht darf nicht leer sein',400);
    if(!(await requireThread(threadId,user!.userId)))return error('Direktnachricht nicht gefunden',403);
    const me=await profileFor(user!);
    const message:Message={id:'msg-'+crypto.randomUUID(),threadId,authorId:user!.userId,author:me.displayName,text,createdAt:Date.now(),reactions:{},attachments,recordType:'message'};
    try {
      await chosenAdd('channels',message);
      await appendMessageToIndex(message);
    } catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      await writeFallbackMessage(message);
    }
    const liveMessage=(await decorateMessages([message]))[0];
    await notifySubscribers('dm',threadId,liveMessage);
    let wallet: ReturnType<typeof walletView> | undefined;
    let pointsEarned = 0;
    try { const reward=await rewardChat(user!.userId,text); wallet=reward.wallet; pointsEarned=reward.earned; }
    catch (err) { console.warn('DM reward skipped after successful send',err); }
    return json({message:liveMessage,...(wallet ? {wallet,pointsEarned} : {})});
  }],
  'PUT /api/dm/messages/:id': [requireAuth(), async ({user,body,params})=>{
    const text=((body as {text?:string})?.text||'').trim().slice(0,2000);
    const message=await getStoredMessage(params.id);
    if(!message||message.authorId!==user!.userId||!message.threadId||!(await requireThread(message.threadId,user!.userId)))return error('Nachricht nicht gefunden oder keine Berechtigung',403);
    if(!text)return error('Nachricht darf nicht leer sein',400);
    const [ok]=await db.tx.update('channels',[{id:params.id,record:{text,editedAt:Date.now()},if:{authorId:user!.userId,recordType:'message',threadId:message.threadId}}],{patch:true});
    if(!ok)return error('Änderung fehlgeschlagen',409);
    const updated=await getStoredMessage(params.id);
    await notifySubscribers('dm',message.threadId,updated);
    return json({message:updated});
  }],
  'DELETE /api/dm/messages/:id': [requireAuth(), async ({user,params})=>{
    const message=await getStoredMessage(params.id);
    if(!message||message.authorId!==user!.userId||!message.threadId||!(await requireThread(message.threadId,user!.userId)))return error('Nachricht nicht gefunden oder keine Berechtigung',403);
    await db.delete('channels',[params.id]);
    await removeMessageFromIndex(message);
    await notifySubscribers('dm',message.threadId,{id:params.id,threadId:message.threadId,deleted:true});
    return json({ok:true});
  }],
  'POST /api/dm/messages/:id/reaction': [requireAuth(), async ({user,params,body})=>{
    const emoji=((body as {emoji?:string})?.emoji||'🍞').slice(0,12);
    const message=await getStoredMessage(params.id);
    if(!message||!message.threadId||!(await requireThread(message.threadId,user!.userId)))return error('Nachricht nicht gefunden',404);
    const reactions={...(message.reactions||{})}; const voters=[...(reactions[emoji]||[])];
    reactions[emoji]=voters.includes(user!.userId)?voters.filter(id=>id!==user!.userId):[...voters,user!.userId];
    const [ok]=await db.tx.update('channels',[{id:params.id,record:{reactions},if:{threadId:message.threadId,recordType:'message'}}],{patch:true});
    if(!ok)return error('Reaktion konnte nicht gespeichert werden',409);
    const updated=await getStoredMessage(params.id);
    await notifySubscribers('dm',message.threadId,updated);
    return json({message:updated});
  }],
  'POST /api/ws/register': [requireAuth(), async ({user,body})=>{
    const connectionId=(body as {connectionId?:string})?.connectionId||'';
    if(!connectionId)return error('Connection fehlt',400);
    const client:FallbackWsClient={id:wsClientRecordId(connectionId),recordType:'ws_client',connectionId,userId:user!.userId,createdAt:Date.now()};
    try { await chosenAdd('servers',client); }
    catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      await writeFallbackWsClient(client);
    }
    return json({ok:true});
  }],
  'POST /api/subscriptions': [requireAuth(), async ({user,body})=>{
    const input=body as {entity_type?:string;entity_id?:string;connection_id?:string};
    const entityType=input?.entity_type||'', entityId=input?.entity_id||'', connectionId=input?.connection_id||'';
    const connection=await getWsClient(connectionId);
    if(!connection||connection.userId!==user!.userId)return error('Verbindung nicht autorisiert',403);
    if(entityType==='channel') {
      if(!(await getChannelForMember(entityId,user!.userId)))return error('Kanal nicht verfügbar',403);
    } else if(entityType==='dm') {
      if(!(await requireThread(entityId,user!.userId)))return error('Direktnachricht nicht verfügbar',403);
    } else if(entityType==='server-members') {
      if(!(await isMember(entityId,user!.userId)))return error('Server-Mitglieder nicht verfügbar',403);
    } else if(entityType==='voice-presence') {
      const channel=await getChannelForMember(entityId,user!.userId);
      if(!channel||channel.kind!=='voice')return error('Sprachkanal-Präsenz nicht verfügbar',403);
    } else return error('Unbekannter Live-Kanal',400);
    try { await addSubscription(entityType,entityId,connectionId); }
    catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      return json({ok:true,degraded:true});
    }
    return json({ok:true});
  }],
  'POST /api/subscriptions/remove': [requireAuth(), async ({user,body})=>{
    const input=body as {entity_type?:string;entity_id?:string;connection_id?:string};
    const connectionId=input?.connection_id||'';
    const connection=await getWsClient(connectionId);
    if(!connection||connection.userId!==user!.userId)return error('Verbindung nicht autorisiert',403);
    await removeSubscriptions(input?.entity_type||'',input?.entity_id||'',connectionId);
    return json({ok:true});
  }],
  'GET /api/diagnostics': [requireAuth(), async ({user,query})=>{
    const serverId=query.serverId || 'toast-zone';
    const channelId=query.channelId || '';
    const results: Array<{name:string;status:'ok'|'missing'|'warning';detail:string}> = [];
    try {
      const [profile] = await db.get<Profile>('profiles',[user!.userId]);
      results.push({name:'Profil-Datenbank',status:profile?'ok':'missing',detail:profile?'Profil lesbar':'Profil fehlt'});
    } catch (err) { results.push({name:'Profil-Datenbank',status:'warning',detail:isAppDatabaseError(err)?err.code:'Lesefehler'}); }
    try {
      const [server] = await db.get<Server>('servers',[serverId]);
      results.push({name:'Server-Datenbank',status:server?'ok':'missing',detail:server?'Server lesbar':'Server nicht gefunden'});
    } catch (err) { results.push({name:'Server-Datenbank',status:'warning',detail:isAppDatabaseError(err)?err.code:'Lesefehler'}); }
    if (channelId) {
      try {
        const [channel] = await db.get<Channel>('channels',[channelId]);
        results.push({name:'Kanal-Datenbank',status:channel?'ok':'missing',detail:channel?'Kanal lesbar':'Kanal nicht gefunden'});
        const type = channel?.kind === 'voice' ? 'voice' : 'message';
        if (type === 'message') {
          const [index] = await db.get<MessageIndex>('channels',[messageIndexId('channel',channelId)]);
          results.push({name:'Nachrichtenindex',status:index?.recordType==='message_index'?'ok':'warning',detail:index?.recordType==='message_index'?index.messageIds.length+' Nachrichten verknüpft':'Index wird beim nächsten Senden erstellt'});
        } else {
          const [index] = await db.get<VoiceIndex>('servers',[voiceIndexId(channelId)]);
          results.push({name:'Sprachindex',status:index?.recordType==='voice_index'?'ok':'warning',detail:index?.recordType==='voice_index'?index.sessionIds.length+' Teilnehmer verknüpft':'Noch keine Sprachsitzungen'});
        }
      } catch (err) { results.push({name:'Kanal-Datenbank',status:'warning',detail:isAppDatabaseError(err)?err.code:'Lesefehler'}); }
    }
    try {
      const index = await getMemberIndex(serverId);
      results.push({name:'Mitgliederindex',status:index?'ok':'warning',detail:index?index.members.length+' Mitglieder indiziert':'Wird beim Serveraufruf aufgebaut'});
    } catch (err) { results.push({name:'Mitgliederindex',status:'warning',detail:isAppDatabaseError(err)?err.code:'Lesefehler'}); }
    return json({checkedAt:Date.now(),results});
  }],
  'GET /api/voice/participants': [requireAuth(), async ({user,query})=>{
    const channelId=query.channelId||'';
    const channel=await getChannelForMember(channelId,user!.userId);
    if(!channel||channel.kind!=='voice')return error('Sprachkanal nicht verfügbar',403);
    const items=await listVoiceSessions(channelId);
    const participants=items.filter(s=>s.channelId===channelId).sort((a,b)=>a.joinedAt-b.joinedAt).map(s=>({userId:s.userId,displayName:s.displayName,joinedAt:s.joinedAt}));
    return json({participants});
  }],
  'POST /api/voice/join': [requireAuth(), async ({user,body})=>{
    const input=body as {channelId?:string;connectionId?:string};
    const channelId=input?.channelId||'', connectionId=input?.connectionId||'';
    const channel=await getChannelForMember(channelId,user!.userId);
    if(!channel||channel.kind!=='voice')return error('Sprachkanal nicht verfügbar',403);
    const client=await getWsClient(connectionId);
    if(!client||client.userId!==user!.userId)return error('Live-Verbindung nicht autorisiert',403);
    const me=await profileFor(user!);
    const items=await listVoiceSessions(channelId);
    const peers=items.filter(s=>s.userId!==user!.userId);
    const session:VoiceSession={id:voiceSessionRecordId(channelId,user!.userId),channelId,userId:user!.userId,displayName:me.displayName,connectionId,joinedAt:Date.now(),recordType:'voice_session'};
    try {
      const [old]=await db.get<VoiceSession>('servers',[session.id]);
      if(old?.recordType==='voice_session') {
        const [updated]=await db.tx.update('servers',[{id:session.id,record:session,if:{recordType:'voice_session',userId:user!.userId,channelId}}],{patch:true});
        if(!updated)return error('Sprachsitzung konnte nicht aktualisiert werden',409);
      } else await chosenAdd('servers',session);
      await addVoiceSessionToIndex(session);
      try {
        const [currentClient] = await db.get<{id:string;userId:string;recordType?:string;voiceChannels?:string[]}>('servers',[wsClientRecordId(connectionId)]);
        if (currentClient?.recordType === 'ws_client') await db.tx.update('servers',[{id:currentClient.id,record:{voiceChannels:Array.from(new Set([...(currentClient.voiceChannels || []),channelId]))},if:{recordType:'ws_client',userId:user!.userId}}],{patch:true});
      } catch (err) { console.warn('Voice disconnect index update failed',err); }
    } catch(err) {
      if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
      await writeFallbackVoiceSession(session);
    }
    await broadcastVoice(channelId,'voice.peer-joined',{userId:user!.userId,displayName:me.displayName,connectionId},user!.userId);
    try { await notifySubscribers('voice-presence', channelId, { action:'joined', participant:{userId:user!.userId,displayName:me.displayName,joinedAt:session.joinedAt} }); }
    catch (err) { console.warn('Voice presence join event failed', err); }
    return json({ok:true,peers:peers.map(p=>({userId:p.userId,displayName:p.displayName}))});
  }],
  'POST /api/voice/leave': [requireAuth(), async ({user,body})=>{
    const channelId=(body as {channelId?:string})?.channelId||'';
    const id=voiceSessionRecordId(channelId,user!.userId);
    const old=await getVoiceSession(channelId,user!.userId);
    if(old?.recordType==='voice_session') {
      try {
        await db.delete('servers',[id]);
        await removeVoiceSessionFromIndex(channelId,user!.userId);
      } catch(err) {
        if(!isAppDatabaseError(err)||err.code!=='AppDatabaseGatewayUnavailable')throw err;
        await removeFallbackVoiceSession(channelId,user!.userId);
      }
      try {
        const client = await getWsClient(old.connectionId);
        if (client) await db.tx.update('servers',[{id:client.id,record:{voiceChannels:(client.voiceChannels || []).filter(id=>id!==channelId)},if:{recordType:'ws_client',userId:user!.userId}}],{patch:true});
      } catch {}
      await broadcastVoice(channelId,'voice.peer-left',{userId:user!.userId},user!.userId);
      try { await notifySubscribers('voice-presence', channelId, { action:'left', userId:user!.userId }); }
      catch (err) { console.warn('Voice presence leave event failed', err); }
    }
    return json({ok:true});
  }],
  'POST /api/voice/signal': [requireAuth(), async ({user,body})=>{
    const input=body as {channelId?:string;targetUserId?:string;signal?:unknown};
    const channelId=input?.channelId||'', targetUserId=input?.targetUserId||'';
    const sender=await getVoiceSession(channelId,user!.userId);
    const target=await getVoiceSession(channelId,targetUserId);
    if(!sender||!target)return error('Sprachchat-Teilnehmer nicht gefunden',404);
    const me=await profileFor(user!);
    await ws.send(target.connectionId,{v:1,type:'voice.signal',payload:{channelId,fromUserId:user!.userId,displayName:me.displayName,signal:input.signal}});
    return json({ok:true});
  }]
 };
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({message:'Success'})],
  ...authRoutes()
});