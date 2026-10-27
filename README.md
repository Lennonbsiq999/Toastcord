# Toastcord

## So startest du Toastcord

**Nur 3 Schritte:**

1. [ZIP herunterladen](https://github.com/Lennonbsiq999/Toastcord/archive/refs/heads/main.zip).
2. Die ZIP-Datei entpacken.
3. **`Start-Toastcord.bat`** doppelklicken.

Fertig. Dein Browser öffnet Toastcord automatisch.

- Beim ersten Start lädt Toastcord die nötige Laufzeit automatisch von der offiziellen Node.js-Webseite herunter und prüft den Download.
- Du musst nichts installieren, keine Befehle eingeben und kein Docker verwenden.
- Das schwarze Fenster muss offen bleiben, solange Toastcord läuft. Zum Beenden schliesst du es.
- Der Starter sucht automatisch einen freien Port zwischen 3000 und 3010. So öffnet er bei einer noch laufenden alten Instanz die neue Version auf einem anderen Port.
- Nachrichten und Konten werden im Ordner `data` gespeichert.

- Beim lokalen Start wird das erste registrierte Konto zum Owner von „Toast Zone“. Falls dein Konto in der lokalen Standard-Community keine Admin-Rechte hat, öffne „Admin-Panel öffnen“ und wähle „Lokalen Server als Owner übernehmen“. Diese Wiederherstellung gilt ausschließlich für „Toast Zone“ und ist nur vom selben PC in einer lokalen Installation erlaubt. Bei Online-Deployments wird kein Admin-Zugriff automatisch vergeben.

## Sprachkanäle: wichtig für Audio

Beim Beitritt wird dein Anwesenheitsstatus auch dann geteilt, wenn der Browser das Mikrofon blockiert. Du erscheinst im Raum und kannst anschließend **„Mikrofon aktivieren“** nutzen. Mikrofon-Audio funktioniert im Browser nur über HTTPS oder auf `localhost`; bei einer gehosteten Version braucht die Website deshalb eine HTTPS-Adresse. Für manche Netzwerke kann der Host zusätzlich TURN konfigurieren.

## Wichtig

Das startet Toastcord **auf deinem eigenen PC**. Damit Freunde über das Internet beitreten können, muss die App später auf einem Online-Server laufen.

## Was drin ist

Chat mit gespeicherten Nachrichten, Konten, Server und Kanäle, Mitgliederliste, Direktnachrichten, **Live-Emoji-Reaktionen**, WebSocket-Liveupdates mit REST-Synchronisierung als Rückfallebene, Sprachkanäle mit WebRTC sowie ToastLab.

Über die immer sichtbare Schaltfläche **„Admin-Panel öffnen“** im Serverbereich gelangst du zur Verwaltung. Owner und Admins sehen dort Mitglieder- und Rollenverwaltung, Servereinstellungen, Nachrichtenmoderation, Live-Statistiken und Audit-Log. Nur der Owner darf Admin-Rechte vergeben oder entfernen. Entfernte Mitglieder verlieren den Kanalzugriff auch nach dem Neuladen.

## Tests

GitHub Actions prüft automatisch den Code und führt die Integrationstests aus.
