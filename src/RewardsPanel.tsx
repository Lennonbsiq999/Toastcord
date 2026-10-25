import { useEffect, useState } from 'react';
import { api } from '@appdeploy/client';
import { BadgeCheck, Ban, Check, Clock, Copy, Crown, Gift, Image, ImagePlus, KeyRound, LockKeyhole, Palette, Shield, ShoppingBag, Sparkles, Ticket, UserRound, X } from 'lucide-react';
import './RewardsPanel.css';

type Tab = 'profile' | 'shop' | 'settings' | 'admin';
type Profile = { userId: string; displayName: string; email?: string; picture?: string; banner?: string; status?: string };
type Wallet = { points: number; badges: string[]; gifts: Record<string, number>; ownedItems: string[]; proUntil: number; isPro: boolean; maxUploadBytes: number };
type AdminUser = { userId: string; displayName: string; email?: string; picture?: string; points: number; badges: string[]; gifts: Record<string, number>; proUntil: number };
type RewardCode = {
  id: string; code: string; rewardType: 'points' | 'gift' | 'badge' | 'pro'; rewardValue: string;
  rewardAmount: number; createdAt: number; expiresAt: number; maxUses: number; uses: number; active: boolean;
};
type Props = {
  initialTab: Tab; accountId: string; profile: Profile | null; rewards: Wallet | null;
  onProfileUpdated: (profile: Profile) => void; onRewardsUpdated: (wallet: Wallet) => void; onNotify: (message: string) => void;
};

const shopItems = [
  { id: 'toast_pro', name: 'Toastcord Pro · 30 Tage', price: 3000, icon: '👑', tag: 'MEISTE EXTRAS', description: '20-MB-Uploads, Pro-Profilbadge, Neon-Profilrahmen und zusätzliche Profilgestaltung.' },
  { id: 'badge_golden', name: 'Goldener Toast', price: 1000, icon: '🥇', tag: 'ABZEICHEN', description: 'Ein dauerhaftes goldenes Abzeichen für dein Profil.' },
  { id: 'frame_neon', name: 'Neon-Profilrahmen', price: 1600, icon: '🌈', tag: 'PROFIL', description: 'Ein leuchtender Rahmen rund um deinen Avatar.' },
  { id: 'gift_box', name: 'Toast-Geschenkbox', price: 250, icon: '🎁', tag: 'GESCHENK', description: 'Eine virtuelle Geschenkbox für dein Inventar.' }
];
const badgeNames: Record<string, string> = {
  toast_legend: 'Toast-Legende', golden_toast: 'Goldener Toast', community_star: 'Community-Star',
  beta_tester: 'Beta-Tester', vip_toast: 'VIP-Toast', pro_member: 'Toastcord Pro'
};
const badgeOptions = [
  ['toast_legend', '🍞 Toast-Legende'], ['golden_toast', '🥇 Goldener Toast'],
  ['community_star', '⭐ Community-Star'], ['beta_tester', '🧪 Beta-Tester'],
  ['vip_toast', '👑 VIP-Toast'], ['pro_member', '✨ Toastcord Pro']
];

function describeCode(code: RewardCode) {
  if (code.rewardType === 'points') return '+' + code.rewardAmount.toLocaleString('de-DE') + ' Toast-Punkte';
  if (code.rewardType === 'gift') return 'Geschenk: ' + (code.rewardValue === 'gift_bouquet' ? 'Toast-Blumen' : 'Geschenkbox');
  if (code.rewardType === 'badge') return 'Abzeichen: ' + (badgeNames[code.rewardValue] || code.rewardValue);
  return 'Toastcord Pro für ' + code.rewardAmount + ' Tage';
}

export default function RewardsPanel({ initialTab, accountId, profile, rewards, onProfileUpdated, onRewardsUpdated, onNotify }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [name, setName] = useState(profile?.displayName || '');
  const [wallet, setWallet] = useState<Wallet | null>(rewards);
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(profile);
  const [saving, setSaving] = useState(false);
  const [adminCode, setAdminCode] = useState('');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [pointsAmount, setPointsAmount] = useState('500');
  const [adminName, setAdminName] = useState('');
  const [statusText, setStatusText] = useState('');
  const [compactMode, setCompactMode] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [codeType, setCodeType] = useState<'points' | 'gift' | 'badge' | 'pro'>('gift');
  const [codeValue, setCodeValue] = useState('gift_box');
  const [codeAmount, setCodeAmount] = useState('500');
  const [codeMaxUses, setCodeMaxUses] = useState('1');
  const [codeExpiryDays, setCodeExpiryDays] = useState('7');
  const [createdCodes, setCreatedCodes] = useState<RewardCode[]>([]);
  const [codeBusy, setCodeBusy] = useState(false);

  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    if (profile) { setCurrentProfile(profile); setName(profile.displayName || ''); }
  }, [profile]);

  useEffect(() => {
    let live = true;
    api.get('/api/rewards/me').then(r => {
      if (!live) return;
      if (r.data.wallet) { setWallet(r.data.wallet); onRewardsUpdated(r.data.wallet); }
      if (r.data.me) { setCurrentProfile(r.data.me); setName(r.data.me.displayName || ''); onProfileUpdated(r.data.me); }
    }).catch(() => {});
    api.get('/api/admin/status').then(r => { if (live && r.data?.unlocked) setAdminUnlocked(true); }).catch(() => {});
    try {
      const compact = localStorage.getItem('toastcord-compact') === '1';
      setCompactMode(compact);
      document.body.classList.toggle('toast-compact', compact);
    } catch {}
    return () => { live = false; };
  }, [accountId]);

  useEffect(() => {
    if (tab !== 'admin' || !adminUnlocked) return;
    let live = true;
    api.get('/api/admin/codes').then(r => { if (live) setCreatedCodes(r.data.codes || []); })
      .catch((err: any) => { if (live) setStatusText(err?.response?.data?.error || 'Codes konnten nicht geladen werden.'); });
    return () => { live = false; };
  }, [tab, adminUnlocked, accountId]);

  async function syncWallet() {
    const r = await api.get('/api/rewards/me');
    if (r.data.wallet) { setWallet(r.data.wallet); onRewardsUpdated(r.data.wallet); }
    if (r.data.me) { setCurrentProfile(r.data.me); onProfileUpdated(r.data.me); }
    return r.data.wallet as Wallet;
  }

  async function saveName(e: any) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const r = await api.put('/api/profile', { displayName: name.trim() });
      setCurrentProfile(r.data.me); onProfileUpdated(r.data.me); onNotify('Profil gespeichert.');
    } catch (err: any) { onNotify(err?.response?.data?.error || 'Profil konnte nicht gespeichert werden.'); }
    finally { setSaving(false); }
  }

  async function uploadAsset(file: File | undefined, slot: 'picture' | 'banner') {
    if (!file) return;
    const maxSize = slot === 'picture' ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { onNotify('Nutze PNG, JPG, WebP oder GIF.'); return; }
    if (file.size > maxSize) { onNotify((slot === 'picture' ? 'Profilbilder' : 'Banner') + ' dürfen maximal ' + Math.round(maxSize / 1024 / 1024) + ' MB groß sein.'); return; }
    setSaving(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
        reader.readAsDataURL(file);
      });
      const r = await api.post('/api/profile/assets', { slot, name: file.name, contentType: file.type, size: file.size, base64 });
      setCurrentProfile(r.data.me); onProfileUpdated(r.data.me);
      onNotify(slot === 'picture' ? 'Profilbild aktualisiert.' : 'Profilbanner aktualisiert.');
    } catch (err: any) { onNotify(err?.response?.data?.error || 'Bild konnte nicht hochgeladen werden.'); }
    finally { setSaving(false); }
  }

  async function buy(itemId: string) {
    setSaving(true);
    try {
      const r = await api.post('/api/shop/buy', { itemId });
      if (r.data.wallet) { setWallet(r.data.wallet); onRewardsUpdated(r.data.wallet); }
      onNotify(r.data.message || 'Im Toast-Shop gekauft.');
    } catch (err: any) { onNotify(err?.response?.data?.error || 'Kauf fehlgeschlagen.'); }
    finally { setSaving(false); }
  }

  async function redeemGiftCode(e: any) {
    e.preventDefault();
    const value = redeemCode.trim();
    if (!value) return;
    setRedeeming(true);
    try {
      const r = await api.post('/api/rewards/redeem', { code: value });
      setRedeemCode('');
      if (r.data.wallet) { setWallet(r.data.wallet); onRewardsUpdated(r.data.wallet); }
      onNotify(r.data.message || 'Code eingelöst. Belohnung hinzugefügt.');
    } catch (err: any) {
      onNotify(err?.response?.data?.error || 'Code konnte nicht eingelöst werden.');
    } finally { setRedeeming(false); }
  }

  async function unlockAdmin(e: any) {
    e.preventDefault(); setAdminBusy(true); setStatusText('');
    try {
      await api.post('/api/admin/unlock', { code: adminCode });
      setAdminUnlocked(true); setAdminCode('');
      setStatusText('Admin-Zugriff aktiv. Er läuft nach einer Stunde automatisch ab.');
      setTab('admin'); onNotify('Admin-Konsole freigeschaltet.');
    } catch (err: any) { setStatusText(err?.response?.data?.error || 'Code wurde abgelehnt.'); }
    finally { setAdminBusy(false); }
  }

  async function searchUsers(e?: any) {
    e?.preventDefault(); setAdminBusy(true);
    try {
      const r = await api.get('/api/admin/users', { q: search.trim() });
      const nextUsers = r.data.users || [];
      setUsers(nextUsers);
      if (selectedUser) {
        const next = nextUsers.find((u: AdminUser) => u.userId === selectedUser.userId);
        if (next) setSelectedUser(next);
      }
      setStatusText(nextUsers.length ? nextUsers.length + ' Konto/Konten gefunden.' : 'Keine passenden Konten gefunden.');
    } catch (err: any) { setAdminUnlocked(false); setStatusText(err?.response?.data?.error || 'Konten konnten nicht geladen werden.'); }
    finally { setAdminBusy(false); }
  }

  async function adminAction(action: string, extra: Record<string, unknown> = {}) {
    if (!selectedUser) { setStatusText('Wähle zuerst ein Konto aus.'); return; }
    setAdminBusy(true);
    try {
      const r = await api.post('/api/admin/action', { targetUserId: selectedUser.userId, action, ...extra });
      setStatusText(r.data.message || 'Admin-Aktion ausgeführt.');
      const updated = await api.get('/api/admin/users', { q: search.trim() });
      setUsers(updated.data.users || []);
      const selected = (updated.data.users || []).find((u: AdminUser) => u.userId === selectedUser.userId);
      if (selected) setSelectedUser(selected);
      await syncWallet();
    } catch (err: any) { setStatusText(err?.response?.data?.error || 'Admin-Aktion fehlgeschlagen.'); }
    finally { setAdminBusy(false); }
  }

  async function createGiftCode(e: any) {
    e.preventDefault();
    setCodeBusy(true);
    try {
      const amount = codeType === 'gift' || codeType === 'badge' ? 1 : Number(codeAmount);
      const value = codeType === 'points' ? 'points' : codeType === 'pro' ? 'days' : codeValue;
      const r = await api.post('/api/admin/codes', {
        rewardType: codeType, rewardValue: value, amount,
        maxUses: Number(codeMaxUses), expiresInDays: Number(codeExpiryDays)
      });
      if (r.data.code) {
        setCreatedCodes(prev => [r.data.code, ...prev.filter(c => c.id !== r.data.code.id)]);
        setStatusText('Code erstellt: ' + r.data.code.code);
        try { await navigator.clipboard.writeText(r.data.code.code); onNotify('Code erstellt und kopiert: ' + r.data.code.code); }
        catch { onNotify('Code erstellt: ' + r.data.code.code); }
      }
    } catch (err: any) {
      setStatusText(err?.response?.data?.error || 'Code konnte nicht erstellt werden.');
    } finally { setCodeBusy(false); }
  }

  async function deactivateCode(code: RewardCode) {
    if (!code.active) return;
    setCodeBusy(true);
    try {
      await api.post('/api/admin/codes/' + encodeURIComponent(code.id) + '/deactivate', {});
      setCreatedCodes(prev => prev.map(c => c.id === code.id ? { ...c, active: false } : c));
      setStatusText('Code ' + code.code + ' wurde deaktiviert.');
    } catch (err: any) { setStatusText(err?.response?.data?.error || 'Code konnte nicht deaktiviert werden.'); }
    finally { setCodeBusy(false); }
  }

  async function copyGiftCode(code: string) {
    try { await navigator.clipboard.writeText(code); onNotify('Code kopiert: ' + code); }
    catch { onNotify('Code: ' + code); }
  }

  function toggleCompact(next: boolean) {
    setCompactMode(next); document.body.classList.toggle('toast-compact', next);
    try { localStorage.setItem('toastcord-compact', next ? '1' : '0'); } catch {}
  }

  const pointBalance = wallet?.points || 0;
  const isPro = Boolean(wallet?.isPro || (wallet?.proUntil && wallet.proUntil > Date.now()));
  const badgeList = wallet?.badges || [];
  const codeRewardOptions = codeType === 'gift'
    ? [['gift_box', '🎁 Geschenkbox'], ['gift_bouquet', '💐 Toast-Blumen']]
    : badgeOptions;

  return (
    <div className="rewards-panel">
      <header className="rewards-head">
        <div className="rewards-brand"><span className="rewards-brand-icon">🍞</span><div><strong>Toastcord</strong><small>Dein Profil. Deine Community. Dein Fortschritt.</small></div></div>
        <div className="rewards-head-actions">{isPro && <span className="pro-pill"><Crown size={14}/> PRO AKTIV</span>}<button type="button" className="rewards-close" aria-label="Schließen" onClick={() => { const el = document.querySelector('.modal-backdrop'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }}><X size={18}/></button></div>
      </header>
      <div className="rewards-tabs">
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}><UserRound size={16}/> Profil</button>
        <button className={tab === 'shop' ? 'active' : ''} onClick={() => setTab('shop')}><ShoppingBag size={16}/> Toast-Shop</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Palette size={16}/> Einstellungen</button>
        {adminUnlocked && <button className={tab === 'admin' ? 'active admin-tab' : 'admin-tab'} onClick={() => { setTab('admin'); void searchUsers(); }}><Shield size={16}/> Admin</button>}
      </div>

      {tab === 'profile' && <section className="rewards-body">
        <div className="profile-hero">
          <div className="profile-banner" style={currentProfile?.banner ? { backgroundImage: 'linear-gradient(135deg, #20243c66, #11182788), url("' + currentProfile.banner + '")' } : undefined}>
            {!currentProfile?.banner && <div className="banner-placeholder"><Sparkles size={24}/><span>DEIN PROFILBANNER</span></div>}
          </div>
          <div className="profile-identity"><div className={'profile-avatar-wrap ' + (isPro || wallet?.ownedItems?.includes('neon_frame') ? 'neon' : '')}>{currentProfile?.picture ? <img className="profile-avatar" src={currentProfile.picture} alt="Profilbild"/> : <div className="profile-avatar profile-avatar-fallback">{(currentProfile?.displayName || 'T').slice(0, 1).toUpperCase()}</div>}</div><div className="profile-names"><strong>{currentProfile?.displayName || 'Toast-Nutzer'} {isPro && <span className="mini-pro">PRO</span>}</strong><small>{accountId}</small><div className="badge-row">{badgeList.length ? badgeList.map(b => <span key={b} className="user-badge"><BadgeCheck size={12}/>{badgeNames[b] || b.replace(/_/g, ' ')}</span>) : <span className="muted-line">Noch keine Abzeichen. Im Shop warten welche.</span>}</div></div></div>
        </div>
        <div className="profile-columns">
          <form className="rewards-card profile-form" onSubmit={saveName}>
            <h3>Profil bearbeiten</h3><p>Der Name erscheint in deinen Nachrichten und in deiner Community.</p><label>Anzeigename</label><input value={name} onChange={e => setName(e.target.value)} maxLength={32} required/>
            <div className="account-meta">{currentProfile?.email || 'Mit sicher angemeldetem Konto verbunden'}</div>
            <button className="rewards-primary" disabled={saving || !name.trim()}><Check size={16}/>{saving ? 'Speichert …' : 'Name speichern'}</button>
          </form>
          <div className="rewards-card upload-card">
            <h3>Profilbilder & Banner</h3><p>Profilbild bis 2 MB, Banner bis 4 MB.</p>
            <label className="upload-choice"><ImagePlus size={18}/><span><strong>Profilbild hochladen</strong><small>PNG, JPG, WebP oder GIF · max. 2 MB</small></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => void uploadAsset(e.target.files?.[0], 'picture')}/></label>
            <label className="upload-choice"><Image size={18}/><span><strong>Profilbanner hochladen</strong><small>PNG, JPG, WebP oder GIF · max. 4 MB</small></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => void uploadAsset(e.target.files?.[0], 'banner')}/></label>
            <div className="wallet-mini"><div><small>TOAST-PUNKTE</small><strong>🍞 {pointBalance.toLocaleString('de-DE')}</strong></div><button type="button" onClick={() => setTab('shop')}>Zum Shop <ShoppingBag size={15}/></button></div>
          </div>
        </div>
        <div className="rewards-card inventory-card"><h3>Dein Inventar</h3><div className="inventory-grid">
          <div><span className="inventory-emoji">🎁</span><strong>{Object.values(wallet?.gifts || {}).reduce((a, b) => a + b, 0)}</strong><small>Geschenke</small></div>
          <div><span className="inventory-emoji">🏅</span><strong>{badgeList.length}</strong><small>Abzeichen</small></div>
          <div><span className="inventory-emoji">🎨</span><strong>{wallet?.ownedItems?.length || 0}</strong><small>Profil-Extras</small></div>
          <div><span className="inventory-emoji">👑</span><strong>{isPro ? 'Aktiv' : 'Nein'}</strong><small>Toastcord Pro</small></div>
        </div></div>
      </section>}

      {tab === 'shop' && <section className="rewards-body">
        <div className="shop-banner"><div><span className="eyebrow">TOAST ECONOMY</span><h2>Ein Toast-Punkt nach dem anderen.</h2><p>Schreib mit, verbringe Zeit im Sprachchat und hol dir Extras, ohne echte Euros auszugeben.</p></div><div className="shop-points"><small>DEIN GUTHABEN</small><strong>🍞 {pointBalance.toLocaleString('de-DE')}</strong><span>Punkte</span></div></div>
        <div className="rewards-card redeem-code-card">
          <h3><Ticket size={18}/> Geschenk- und Prämiencode einlösen</h3>
          <p>Du brauchst keine Admin-Rechte. Gib einen Code ein, den dir ein Admin geschickt hat.</p>
          <form className="redeem-code-form" onSubmit={redeemGiftCode}>
            <input aria-label="Einlösecode" autoComplete="off" value={redeemCode} onChange={e => setRedeemCode(e.target.value)} placeholder="z. B. TOAST-AB12CD34EF56" maxLength={80}/>
            <button className="rewards-primary" disabled={redeeming || !redeemCode.trim()}><Gift size={15}/>{redeeming ? 'Prüft …' : 'Code einlösen'}</button>
          </form>
        </div>
        <div className="earn-rules"><div><span className="earn-emoji">💬</span><span><strong>+5 Punkte</strong><small>Für eine Chatnachricht ab 8 Zeichen, höchstens alle 30 Sekunden.</small></span></div><div><span className="earn-emoji">🎙️</span><span><strong>+10 Punkte</strong><small>Pro bestätigter Minute im Sprachkanal.</small></span></div></div>
        <div className="shop-grid">{shopItems.map(item => {
          const owned = (item.id === 'badge_golden' && badgeList.includes('golden_toast')) || (item.id === 'frame_neon' && wallet?.ownedItems?.includes('neon_frame'));
          return <article className={'shop-item ' + (item.id === 'toast_pro' ? 'featured' : '')} key={item.id}>
            <div className="shop-item-top"><span className="shop-item-icon">{item.icon}</span><span className="shop-tag">{item.tag}</span></div>
            <h3>{item.name}</h3><p>{item.description}</p><div className="shop-buy-row"><strong>🍞 {item.price.toLocaleString('de-DE')}</strong><button disabled={saving || owned || pointBalance < item.price} className="rewards-primary" onClick={() => void buy(item.id)}>{owned ? 'Bereits freigeschaltet' : saving ? 'Lädt …' : 'Einlösen'}</button></div>
          </article>;
        })}</div>
        <div className="pro-details"><Crown size={20}/><div><strong>Toastcord Pro</strong><p>30 Tage Pro: 20-MB-Dateiuploads, Pro-Profilbadge, Neonrahmen und besondere Profilextras. Keine Zahlung, nur erspielte Punkte.</p>{isPro && <small>Aktiv bis {new Date(wallet?.proUntil || 0).toLocaleDateString('de-DE')}.</small>}</div></div>
      </section>}

      {tab === 'settings' && <section className="rewards-body settings-body">
        <h2>Einstellungen</h2><p>Deine Oberfläche und dein Admin-Zugang. Der Admin-Code wird nur an den Server gesendet.</p>
        <div className="rewards-card settings-option"><div className="setting-icon"><Palette/></div><div className="setting-copy"><strong>Kompakte Oberfläche</strong><small>Etwas weniger Abstand, etwas mehr Platz für Nachrichten.</small></div><label className="switch"><input type="checkbox" checked={compactMode} onChange={e => toggleCompact(e.target.checked)}/><span/></label></div>
        <div className="rewards-card settings-option"><div className="setting-icon admin"><KeyRound/></div><div className="setting-copy"><strong>Admin-Konsole</strong><small>Codes für Punkte, Geschenke, Abzeichen und Pro erstellen und andere Nutzer verwalten.</small>
          <form className="admin-code-form" onSubmit={unlockAdmin}><input type="password" inputMode="numeric" autoComplete="off" value={adminCode} onChange={e => setAdminCode(e.target.value)} placeholder="Admin-Code" maxLength={32}/><button className="rewards-primary" disabled={adminBusy || !adminCode.trim()}><LockKeyhole size={15}/>{adminBusy ? 'Prüft …' : 'Freischalten'}</button></form>
          {statusText && <div className="admin-status">{statusText}</div>}
          {adminUnlocked && <button className="admin-open" onClick={() => { setTab('admin'); void searchUsers(); }}>Admin-Konsole öffnen <Shield size={15}/></button>}
        </div></div>
        <div className="security-note"><Shield size={18}/><span>Admin-Zugriff läuft serverseitig nach einer Stunde ab. Nach fünf falschen Codes wird die Freischaltung vorübergehend gesperrt.</span></div>
      </section>}

      {tab === 'admin' && <section className="rewards-body admin-body">
        <div className="admin-heading"><div><span className="eyebrow">PRIVILEGIERTER BEREICH</span><h2>Toastcord Admin</h2><p>Verwalte Konten und erstelle Codes, die andere Mitglieder selbst einlösen können.</p></div><span className="admin-live"><span/> Zugriff aktiv</span></div>
        <div className="rewards-card code-admin-card">
          <h3><Ticket size={18}/> Geschenk- und Prämiencodes erstellen</h3>
          <p>Codes können Punkte, virtuelle Geschenke, Abzeichen oder Toastcord Pro vergeben. Du kannst die Zahl der Einlösungen und die Gültigkeitsdauer festlegen.</p>
          <form className="admin-code-create" onSubmit={createGiftCode}>
            <div className="admin-code-fields">
              <label>Belohnungstyp<select value={codeType} onChange={e => { const t = e.target.value as 'points' | 'gift' | 'badge' | 'pro'; setCodeType(t); setCodeValue(t === 'gift' ? 'gift_box' : t === 'badge' ? 'toast_legend' : t === 'points' ? 'points' : 'days'); setCodeAmount(t === 'pro' ? '30' : '500'); }}><option value="gift">Geschenk</option><option value="points">Toast-Punkte</option><option value="badge">Abzeichen</option><option value="pro">Toastcord Pro</option></select></label>
              {(codeType === 'gift' || codeType === 'badge') && <label>Belohnung<select value={codeValue} onChange={e => setCodeValue(e.target.value)}>{codeRewardOptions.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select></label>}
              {(codeType === 'points' || codeType === 'pro') && <label>{codeType === 'points' ? 'Punkte' : 'Pro-Tage'}<input type="number" value={codeAmount} min="1" max={codeType === 'points' ? '1000000' : '365'} onChange={e => setCodeAmount(e.target.value)} required/></label>}
              <label>Max. Einlösungen<input type="number" value={codeMaxUses} min="1" max="5000" onChange={e => setCodeMaxUses(e.target.value)} required/></label>
              <label>Gültigkeit in Tagen<input type="number" value={codeExpiryDays} min="0" max="365" onChange={e => setCodeExpiryDays(e.target.value)} required/><small>0 = kein Ablaufdatum</small></label>
            </div>
            <button className="rewards-primary" disabled={codeBusy || codeMaxUses === '' || codeExpiryDays === '' || ((codeType === 'points' || codeType === 'pro') && !Number(codeAmount))}><Ticket size={16}/>{codeBusy ? 'Erstellt …' : 'Code erstellen & kopieren'}</button>
          </form>
          <div className="admin-code-list">
            <h4>Vorhandene Codes</h4>
            {createdCodes.map(code => <div className={'admin-code-row ' + (!code.active ? 'inactive' : '')} key={code.id}>
              <div className="admin-code-main"><strong>{code.code} {!code.active && <span className="code-inactive-label">INAKTIV</span>}</strong><small>{describeCode(code)}</small><small><span>{code.uses}/{code.maxUses} Einlösungen</span> · <Clock size={11}/>{code.expiresAt ? ' ' + new Date(code.expiresAt).toLocaleDateString('de-DE') : ' Kein Ablaufdatum'}</small></div>
              <div className="admin-code-actions"><button type="button" title="Code kopieren" onClick={() => void copyGiftCode(code.code)}><Copy size={14}/> Kopieren</button><button type="button" className="code-deactivate" disabled={codeBusy || !code.active} onClick={() => void deactivateCode(code)}><Ban size={14}/> Deaktivieren</button></div>
            </div>)}
            {!createdCodes.length && <div className="admin-empty">Noch keine Codes erstellt.</div>}
          </div>
        </div>
        <form className="admin-search" onSubmit={searchUsers}><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nutzername, E-Mail oder Konto-ID …"/><button className="rewards-primary" disabled={adminBusy}><UserRound size={16}/> Suchen</button></form>
        <div className="admin-layout">
          <div className="admin-users">{users.map(user => <button type="button" key={user.userId} className={'admin-user ' + (selectedUser?.userId === user.userId ? 'selected' : '')} onClick={() => { setSelectedUser(user); setAdminName(user.displayName); setStatusText('Konto ausgewählt.'); }}><span className="admin-avatar">{user.picture ? <img src={user.picture} alt=""/> : user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.points.toLocaleString('de-DE')} Punkte · {user.badges.length} Abzeichen</small></span><span className="admin-id">{user.userId.slice(0, 8)}</span></button>)}{!users.length && <div className="admin-empty">Suche nach einem Konto, um es auszuwählen.</div>}</div>
          <div className="admin-actions">
            {selectedUser ? <>
              <div className="admin-selected"><strong>{selectedUser.displayName}</strong><small>{selectedUser.userId}</small></div>
              <label className="admin-label">PUNKTE VERGEBEN / ABZIEHEN</label><div className="admin-inline"><input type="number" value={pointsAmount} onChange={e => setPointsAmount(e.target.value)} min="1" max="100000"/><button type="button" disabled={adminBusy || !Number(pointsAmount)} onClick={() => void adminAction('points', { amount: Math.abs(Number(pointsAmount)) })}>+ Geben</button><button type="button" className="subtle-danger" disabled={adminBusy || !Number(pointsAmount)} onClick={() => void adminAction('points', { amount: -Math.abs(Number(pointsAmount)) })}>− Abziehen</button></div>
              <label className="admin-label">ABZEICHEN GEBEN</label><div className="admin-action-grid">
                <button type="button" disabled={adminBusy} onClick={() => void adminAction('badge', { badgeId: 'toast_legend' })}>🍞 Toast-Legende</button>
                <button type="button" disabled={adminBusy} onClick={() => void adminAction('badge', { badgeId: 'community_star' })}>⭐ Community-Star</button>
                <button type="button" disabled={adminBusy} onClick={() => void adminAction('badge', { badgeId: 'beta_tester' })}>🧪 Beta-Tester</button>
                <button type="button" disabled={adminBusy} onClick={() => void adminAction('badge', { badgeId: 'vip_toast' })}>👑 VIP-Toast</button>
              </div>
              <label className="admin-label">GESCHENK SENDEN</label><div className="admin-action-grid"><button type="button" disabled={adminBusy} onClick={() => void adminAction('gift', { giftId: 'gift_box' })}>🎁 Geschenkbox</button><button type="button" disabled={adminBusy} onClick={() => void adminAction('gift', { giftId: 'gift_bouquet' })}>💐 Toast-Blumen</button></div>
              <label className="admin-label">TOASTCORD PRO</label><div className="admin-inline"><button type="button" disabled={adminBusy} onClick={() => void adminAction('pro', { months: 1 })}>+ 1 Monat</button><button type="button" disabled={adminBusy} onClick={() => void adminAction('pro', { months: 3 })}>+ 3 Monate</button><button type="button" disabled={adminBusy} onClick={() => void adminAction('remove_pro')}>Pro entfernen</button></div>
              <label className="admin-label">ANZEIGENAME ÄNDERN</label><div className="admin-inline"><input value={adminName} onChange={e => setAdminName(e.target.value)} maxLength={32}/><button type="button" disabled={adminBusy || !adminName.trim()} onClick={() => void adminAction('set_name', { displayName: adminName.trim() })}>Speichern</button></div>
            </> : <div className="admin-empty">Wähle links ein Konto aus. Danach erscheinen Verwaltungsaktionen.</div>}
          </div>
        </div>
        {statusText && <div className="admin-status">{statusText}</div>}
        <div className="security-note"><Shield size={18}/><span>Alle privilegierten Aktionen werden serverseitig geprüft. Codes lassen sich sofort deaktivieren.</span></div>
      </section>}
    </div>
  );
}
