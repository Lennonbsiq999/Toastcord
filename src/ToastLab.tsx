import { useEffect, useState } from 'react';
import { api } from '@appdeploy/client';
import { Bookmark, ClipboardList, FileDown, Keyboard, MessageCircle, Palette, Search, Settings, ShieldCheck, Sparkles, StickyNote, Users, X } from 'lucide-react';

type ServerInfo = { id: string; name: string };
type Channel = { id: string; serverId: string; name: string; kind: 'text' | 'voice'; createdAt: number };
type ChatAttachment = { id: string; name: string; contentType: string; size: number };
type ChatMessage = { id: string; channelId?: string; threadId?: string; authorId: string; author: string; text: string; createdAt: number; attachments?: ChatAttachment[] };
type DiagnosticResult = { name: string; status: 'ok' | 'missing' | 'warning'; detail: string };
type Props = {
  accountId: string; servers: ServerInfo[]; channels: Channel[]; messages: ChatMessage[]; savedMessages: ChatMessage[];
  draft: string; mode: 'channel' | 'dm'; activeServerId: string; activeChannelId: string; activeThreadId: string; status: string;
  onStatusChange: (status: string) => Promise<void>; onUpdateDraft: (draft: string) => void;
  onToggleSaved: (message: ChatMessage) => void; onOpenSaved: (message: ChatMessage) => void;
  onSwitchChannel: (channel: Channel) => void; onFocusMode: () => void; onClose: () => void; onNotify: (message: string) => void;
};

export default function ToastLab(props: Props) {
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');
  const [optionsText, setOptionsText] = useState('Ja\nNein');
  const [switchQuery, setSwitchQuery] = useState('');
  const [accent, setAccent] = useState('#5865f2');
  const [status, setStatus] = useState(props.status || 'online');
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult[]>([]);

  useEffect(() => {
    try {
      setNote(localStorage.getItem('toastcord-notes-' + props.accountId) || '');
      setAccent(localStorage.getItem('toastcord-accent-' + props.accountId) || '#5865f2');
    } catch {}
    setStatus(props.status || 'online');
  }, [props.accountId]);

  useEffect(() => {
    try { localStorage.setItem('toastcord-notes-' + props.accountId, note); } catch {}
  }, [props.accountId, note]);

  useEffect(() => {
    document.documentElement.style.setProperty('--toast-accent', accent);
    try { localStorage.setItem('toastcord-accent-' + props.accountId, accent); } catch {}
  }, [props.accountId, accent]);

  function formatDraft(prefix: string, suffix = prefix) {
    props.onUpdateDraft(prefix + (props.draft || 'Text') + suffix);
    props.onClose();
  }

  function preparePoll() {
    const pollQuestion = question.trim();
    const answers = optionsText.split(/\r?\n/).map(v => v.trim()).filter(Boolean).slice(0, 8);
    if (!pollQuestion || answers.length < 2) { props.onNotify('Eine Umfrage braucht eine Frage und mindestens zwei Antworten.'); return; }
    const icons = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'];
    props.onUpdateDraft('📊 UMFRAGE: ' + pollQuestion + '\n\n' + answers.map((answer, i) => icons[i] + ' ' + answer).join('\n') + '\n\nReagiere mit der passenden Zahl.');
    props.onClose(); props.onNotify('Umfrage ist vorbereitet. Prüfe sie und sende sie ab.');
  }


  function exportCurrentChat() {
    const current = props.messages.filter(m => props.mode === 'dm' ? m.threadId === props.activeThreadId : m.channelId === props.activeChannelId);
    const body = current.map(m => '[' + new Date(m.createdAt).toLocaleString('de-DE') + '] ' + m.author + ': ' + m.text + (m.attachments?.length ? ' [Dateien: ' + m.attachments.map(a => a.name).join(', ') + ']' : '')).join('\n');
    const blob = new Blob([body || 'Dieser Chat enthält noch keine geladenen Nachrichten.'], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'toastcord-chat.txt'; link.click(); URL.revokeObjectURL(url);
    props.onNotify('Chat wurde als TXT exportiert.');
  }

  async function runDiagnostics() {
    setDiagnostics([]);
    try {
      const response = await api.get('/api/diagnostics', {serverId: props.activeServerId, channelId: props.mode === 'channel' ? props.activeChannelId : ''});
      setDiagnostics((response.data.results || []) as DiagnosticResult[]);
      props.onNotify('Systemdiagnose abgeschlossen.');
    } catch (error: any) { props.onNotify(error?.response?.data?.error || 'Systemdiagnose fehlgeschlagen.'); }
  }

  const filteredChannels = props.channels.filter(c => (c.name + ' ' + (props.servers.find(s => s.id === c.serverId)?.name || '')).toLocaleLowerCase().includes(switchQuery.toLocaleLowerCase())).slice(0, 10);
  return <div className="toastlab">
    <div className="toastlab-hero"><div className="modal-icon"><Sparkles/></div><div><div className="eyebrow">TOASTCORD POWER TOOLS</div><h2>ToastLab</h2><p>Zwölf praktische Werkzeuge, die nicht bloß hübsche Knöpfe sind.</p></div></div>
    <div className="toastlab-grid">
      <section className="tool-card"><div className="tool-card-title"><Bookmark/><div><strong>1. Merkliste</strong><small>{props.savedMessages.length} gespeicherte Nachrichten</small></div></div>{props.savedMessages.length ? props.savedMessages.slice(-8).reverse().map(message => <div className="tool-list-row" key={message.id}><button className="tool-link" onClick={() => props.onOpenSaved(message)}><strong>{message.author}</strong><span>{message.text || 'Dateianhang'}</span></button><button className="tool-icon-button" onClick={() => props.onToggleSaved(message)} title="Aus Merkliste entfernen"><X size={15}/></button></div>) : <p className="tool-muted">Klicke an einer Nachricht auf das Lesezeichen.</p>}</section>
      <section className="tool-card"><div className="tool-card-title"><StickyNote/><div><strong>2. Private Notizen</strong><small>Automatisch im Browser gespeichert</small></div></div><textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Ideen, To-dos, IPs oder Spielpläne …" rows={5}/></section>
      <section className="tool-card"><div className="tool-card-title"><ClipboardList/><div><strong>3. Umfrage bauen</strong><small>Als Nachricht in den Chat setzen</small></div></div><input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Deine Frage"/><textarea value={optionsText} onChange={e => setOptionsText(e.target.value)} rows={3} placeholder="Eine Antwort pro Zeile"/><button className="primary tool-action" onClick={preparePoll}>Umfrage vorbereiten</button></section>
      <section className="tool-card"><div className="tool-card-title"><Keyboard/><div><strong>4. Slash-Befehle</strong><small>Direkt im Chat ausführen</small></div></div><div className="tool-chip-row">{['/help','/roll','/flip','/choose Pizza | Pasta','/shrug','/me winkt','/poll Spiel? | Ja | Nein'].map(cmd => <button className="tool-chip" key={cmd} onClick={() => {props.onUpdateDraft(cmd);props.onClose();}}>{cmd}</button>)}</div></section>
      <section className="tool-card"><div className="tool-card-title"><Search/><div><strong>5. Schnellwechsler</strong><small>Strg+K öffnet das ToastLab jederzeit</small></div></div><input value={switchQuery} onChange={e => setSwitchQuery(e.target.value)} placeholder="Server oder Kanal suchen …"/><div className="tool-switch-list">{filteredChannels.map(channel => <button key={channel.id} onClick={() => props.onSwitchChannel(channel)}><span>{channel.kind === 'voice' ? '🔊' : '#'} {channel.name}</span><small>{props.servers.find(s => s.id === channel.serverId)?.name || 'Server'}</small></button>)}</div></section>
      <section className="tool-card"><div className="tool-card-title"><FileDown/><div><strong>6. Chat exportieren</strong><small>TXT mit Zeitstempeln und Dateinamen</small></div></div><p className="tool-muted">Exportiert alle aktuell geladenen Nachrichten dieses Chats.</p><button className="primary tool-action" onClick={exportCurrentChat}>TXT exportieren</button></section>
      <section className="tool-card"><div className="tool-card-title"><Sparkles/><div><strong>7. Formatierung</strong><small>Fett, kursiv, Code, Spoiler, Zitat</small></div></div><div className="tool-chip-row"><button className="tool-chip" onClick={() => formatDraft('**')}>Fett</button><button className="tool-chip" onClick={() => formatDraft('*')}>Kursiv</button><button className="tool-chip" onClick={() => formatDraft('`')}>Code</button><button className="tool-chip" onClick={() => formatDraft('||')}>Spoiler</button><button className="tool-chip" onClick={() => formatDraft('> ','')}>Zitat</button></div></section>
      <section className="tool-card"><div className="tool-card-title"><MessageCircle/><div><strong>8. Schnellantworten</strong><small>Entwürfe mit einem Klick</small></div></div><div className="tool-chip-row">{['Bin gleich da.','Kannst du das genauer erklären?','Danke, hat funktioniert!','Ich teste es kurz.'].map(reply => <button className="tool-chip" key={reply} onClick={() => {props.onUpdateDraft(reply);props.onClose();}}>{reply}</button>)}</div></section>
      <section className="tool-card"><div className="tool-card-title"><Palette/><div><strong>9. Akzentfarbe</strong><small>Ändert Hauptbuttons und merkt sich die Auswahl</small></div></div><div className="tool-color-row">{['#5865f2','#ed4245','#3ba55c','#faa61a','#9b59b6','#00a8fc'].map(color => <button key={color} title={color} style={{background:color}} className={accent === color ? 'tool-color selected-color' : 'tool-color'} onClick={() => setAccent(color)}/>)}</div></section>
      <section className="tool-card"><div className="tool-card-title"><Settings/><div><strong>10. Fokusmodus</strong><small>Blendet die Mitgliederleiste aus</small></div></div><button className="primary tool-action" onClick={() => {props.onFocusMode();props.onClose();}}>Fokusmodus umschalten</button></section>
      <section className="tool-card"><div className="tool-card-title"><Users/><div><strong>11. Online-Status</strong><small>Wird serverseitig im Profil gespeichert</small></div></div><select value={status} onChange={e => {setStatus(e.target.value);void props.onStatusChange(e.target.value);}}><option value="online">Online</option><option value="away">Abwesend</option><option value="dnd">Nicht stören</option><option value="offline">Unsichtbar</option></select></section>
      <section className="tool-card"><div className="tool-card-title"><ShieldCheck/><div><strong>12. Systemdiagnose</strong><small>Prüft die tatsächlichen Backend-Datenpfade</small></div></div><button className="primary tool-action" onClick={() => void runDiagnostics()}>System jetzt prüfen</button>{diagnostics.length > 0 && <div className="diagnostic-results">{diagnostics.map(item => <div className="diagnostic-row" key={item.name}><span className={'diagnostic-dot ' + item.status}/><div><strong>{item.name}</strong><small>{item.detail}</small></div></div>)}</div>}</section>
    </div>
    <div className="toastlab-footer"><span>Entwürfe werden pro Chat lokal gespeichert. Öffnen mit Strg+K.</span><button onClick={props.onClose}>Fertig</button></div>
  </div>;
}
