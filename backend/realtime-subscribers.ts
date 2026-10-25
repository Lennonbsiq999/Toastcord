import { createHash } from 'node:crypto';
import { db, ws } from '@appdeploy/sdk';

type SubscriptionRecord = { id: string; recordType: string; entity_type: string; entity_id: string; connection_id: string; created_at: number };
type SubscriptionIndex = { id: string; recordType: 'subscription_index'; entity_type: string; entity_id: string; subscriptionIds: string[]; updatedAt: number };
type VoiceSession = { id: string; recordType: string; channelId: string; userId: string; displayName: string; connectionId: string; joinedAt: number };
type VoiceIndex = { id: string; recordType: 'voice_index'; channelId: string; sessionIds: string[]; updatedAt: number };
type WsClientRecord = { id: string; recordType: string; userId: string; connectionId: string; createdAt: number; voiceChannels?: string[]; subscriptionIds?: string[] };
function stableStoreKey(prefix: string, ...parts: string[]) {
  return prefix + createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0,40);
}
function wsClientRecordId(connectionId: string) { return stableStoreKey('ws-', connectionId); }
function subscriptionIndexId(entityType: string, entityId: string) { return stableStoreKey('subidx-', entityType, entityId); }
function subscriptionRecordId(entityType: string, entityId: string, connectionId: string) { return stableStoreKey('sub-', entityType, entityId, connectionId); }
function voiceIndexId(channelId: string) { return stableStoreKey('voiceidx-', channelId); }
function voiceSessionRecordId(channelId: string, userId: string) { return stableStoreKey('voice-', channelId, userId); }
async function getWsClient(connectionId: string): Promise<WsClientRecord | null> {
  const [client] = await db.get<WsClientRecord>('servers', [wsClientRecordId(connectionId)]);
  return client?.recordType === 'ws_client' ? client : null;
}
async function updateIndex(indexId: string, recordType: 'subscription_index' | 'voice_index', field: 'subscriptionIds' | 'sessionIds', value: string, scope: Record<string, string>) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const [old] = await db.get<any>('servers', [indexId]);
    const now = Date.now();
    const list: string[] = old?.recordType === recordType ? old[field] || [] : [];
    const next = [...list.filter(id => id !== value), value].slice(-500);
    if (old?.recordType !== recordType) {
      const [created] = await db.tx.add('servers', [{ id: indexId, recordType, ...scope, [field]: next, updatedAt: now }]);
      if (created) return;
      continue;
    }
    const [updated] = await db.tx.update('servers', [{ id: indexId, record: { [field]: next, updatedAt: now }, if: { recordType, updatedAt: old.updatedAt } }], { patch: true });
    if (updated) return;
  }
  throw new Error('Realtime index update failed');
}
async function removeFromIndex(indexId: string, recordType: 'subscription_index' | 'voice_index', field: 'subscriptionIds' | 'sessionIds', value: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [old] = await db.get<any>('servers', [indexId]);
    if (old?.recordType !== recordType) return;
    const [updated] = await db.tx.update('servers', [{ id: indexId, record: { [field]: (old[field] || []).filter((id: string) => id !== value), updatedAt: Date.now() }, if: { recordType, updatedAt: old.updatedAt } }], { patch: true });
    if (updated) return;
  }
}
async function indexedVoiceSessions(channelId: string): Promise<VoiceSession[]> {
  const [index] = await db.get<VoiceIndex>('servers', [voiceIndexId(channelId)]);
  if (index?.recordType !== 'voice_index' || !index.sessionIds.length) return [];
  const sessions = await db.get<VoiceSession>('servers', index.sessionIds);
  return sessions.filter((s): s is VoiceSession => Boolean(s && s.recordType === 'voice_session' && s.channelId === channelId && s.connectionId));
}
export async function removeSubscriptionsByConnection(connectionId: string) {
  const client = await getWsClient(connectionId);
  for (const id of client?.subscriptionIds || []) {
    const [item] = await db.get<SubscriptionRecord>('servers', [id]);
    if (item?.recordType === 'subscription') {
      await removeSubscriptions(item.entity_type, item.entity_id, connectionId);
    }
  }
}
export async function addSubscription(entityType: string, entityId: string, connectionId: string) {
  const id = subscriptionRecordId(entityType, entityId, connectionId);
  const [existing] = await db.get<SubscriptionRecord>('servers', [id]);
  if (existing?.recordType !== 'subscription') {
    const [created] = await db.tx.add('servers', [{ id, recordType: 'subscription', entity_type: entityType, entity_id: entityId, connection_id: connectionId, created_at: Date.now() }]);
    if (!created) {
      const [check] = await db.get<SubscriptionRecord>('servers', [id]);
      if (check?.recordType !== 'subscription') throw new Error('Subscription record could not be created');
    }
  }
  await updateIndex(subscriptionIndexId(entityType, entityId), 'subscription_index', 'subscriptionIds', id, { entity_type: entityType, entity_id: entityId });
  const client = await getWsClient(connectionId);
  if (client) await db.tx.update('servers', [{ id: client.id, record: { subscriptionIds: [...new Set([...(client.subscriptionIds || []), id])].slice(-500) }, if: { recordType: 'ws_client', userId: client.userId } }], { patch: true });
}
export async function removeSubscriptions(entityType: string, entityId: string, connectionId: string) {
  const id = subscriptionRecordId(entityType, entityId, connectionId);
  await db.delete('servers', [id]);
  await removeFromIndex(subscriptionIndexId(entityType, entityId), 'subscription_index', 'subscriptionIds', id);
  const client = await getWsClient(connectionId);
  if (client) await db.tx.update('servers', [{ id: client.id, record: { subscriptionIds: (client.subscriptionIds || []).filter(item => item !== id) }, if: { recordType: 'ws_client', userId: client.userId } }], { patch: true });
}
export async function notifySubscribers(entityType: string, entityId: string, payload: unknown, excludeConnectionId?: string) {
  try {
    const [index] = await db.get<SubscriptionIndex>('servers', [subscriptionIndexId(entityType, entityId)]);
    if (index?.recordType !== 'subscription_index' || !index.subscriptionIds.length) return;
    const records: SubscriptionRecord[] = [];
    for (let offset = 0; offset < index.subscriptionIds.length; offset += 100) {
      const group = index.subscriptionIds.slice(offset, offset + 100);
      const rows = await db.get<SubscriptionRecord>('servers', group);
      records.push(...rows.filter((row): row is SubscriptionRecord => Boolean(row && row.recordType === 'subscription')));
    }
    const targets = [...new Set(records.filter(i => i.entity_type === entityType && i.entity_id === entityId).map(i => i.connection_id).filter(id => id !== excludeConnectionId))];
    if (targets.length) await ws.send(targets, { v: 1, type: 'entity.update', payload: { entity_type: entityType, entity_id: entityId, data: payload } });
  } catch (err) {
    console.warn('Realtime notification delivery failed', { entityType, entityId, error: String(err) });
  }
}
export async function removeConnectionState(connectionId: string) {
  try { await removeSubscriptionsByConnection(connectionId); } catch {}
  try {
    const client = await getWsClient(connectionId);
    for (const channelId of client?.voiceChannels || []) {
      const sessionId = voiceSessionRecordId(channelId, client!.userId);
      const [session] = await db.get<VoiceSession>('servers', [sessionId]);
      if (session?.recordType !== 'voice_session' || session.connectionId !== connectionId) continue;
      await db.delete('servers', [sessionId]);
      await removeFromIndex(voiceIndexId(channelId), 'voice_index', 'sessionIds', sessionId);
      const remaining = await indexedVoiceSessions(channelId);
      const ids = remaining.filter(s => s.userId !== session.userId).map(s => s.connectionId);
      if (ids.length) await ws.send([...new Set(ids)], { v: 1, type: 'voice.peer-left', payload: { channelId, userId: session.userId } });
    }
  } catch (err) { console.warn('Voice disconnect cleanup failed', String(err)); }
  try { await db.delete('servers', [wsClientRecordId(connectionId)]); } catch {}
}