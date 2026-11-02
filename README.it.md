# Macro pad

> 🇬🇧 [English README](README.md) · 🇮🇹 Italiano (questa pagina)

Un macro pad touch per il tablet (Lenovo Duet), configurato dal Mac. Un solo
processo Bun/TS, frontend vanilla, nessuna dipendenza e nessun build step.
Il progetto è pensato per **ridare vita a tablet vecchi o deboli**.

- **Pad** `http://<ip-del-mac>:8430/` — la griglia di pulsanti, da aprire sul tablet.
- **Editor** `http://localhost:8430/edit` — solo dal Mac. Crea, sposta, programma e prova i pulsanti.

Gira **nativo sul Mac, non in Docker**: le azioni (`osascript`, `open`, shell) devono
agire sul Mac, non dentro un container.

## Avvio

```bash
cd ~/coding/macrocenter
bun start          # oppure: bun run dev (riavvia a ogni modifica del server)
```

Sul tablet apri l'indirizzo mostrato in alto a destra nell'editor (clic = copia).
A tutto schermo: pulsante ⛶ in basso a destra.

Variabili: `PORT` (8430), `HOST` (0.0.0.0), `DATA_DIR` (`./data`).

### Lingua

Il default è l'inglese. Per l'italiano apri `/?lang=it` (la scelta viene ricordata nel
browser); senza scelta si usa la lingua del browser, se disponibile. L'editor ha un
selettore di lingua. I messaggi del server (errori, risultati) sono solo in inglese.

### Sempre acceso (launchd)

Compose non è adatto: il container è una VM Linux e non può eseguire `osascript`/`open`
sul Mac. Si usa un LaunchAgent, che parte al login e viene rilanciato se cade:

```bash
scripts/launchd.sh install     # status | uninstall
```

Log in `~/Library/Logs/macrocenter.log`. Il percorso di `bun` è fissato all'installazione
(versione inclusa): se mise lo aggiorna e rimuove la vecchia, rilancia `install`.
Il permesso Accessibilità va dato al binario `bun` (non al Terminale) perché il processo
lo lancia launchd.

## Cosa può fare un pulsante

Un pulsante è una **lista ordinata di azioni**; si ferma al primo errore
(salvo «continua se fallisce», vedi sotto).

| Azione | Cosa fa | Note |
|---|---|---|
| Comando shell | `zsh -lc "<cmd>"`, cartella e timeout (default 30 s, max 300) | Il timeout uccide anche i figli. Un `cmd &` in background non blocca il pulsante. `$PAD_BUTTON` = id del pulsante |
| AppleScript | `osascript` da stdin (timeout 30 s) | |
| Azione Mac | Azione del catalogo (vedi sotto), genera l'AppleScript | Alcune richiedono *Accessibilità* |
| Scorciatoia | `cmd+shift+4`, `ctrl+left`, `f5`… Un modificatore da solo (`opt`, `cmd+shift`) viene premuto e rilasciato. Con **Pressioni** (1–10) e un intervallo (ms) per ripetizioni rapide, per esempio il doppio tocco di Option | Pulsante **Registra** nell'editor. Serve *Accessibilità* |
| Scrivi testo | Digita il testo (a-capo = Invio) | Serve *Accessibilità* |
| Apri | URL, file, cartella e/o app (`open`) | |
| HTTP | GET/POST/PUT/PATCH/DELETE con header e body, timeout 10 s | Solo `http(s)://` |
| Click del mouse (`click`) | Sinistro/destro/centrale, 1–3 click (doppio click = 2), dove si trova il puntatore o a coordinate fisse | Serve *Accessibilità*. Le cifre in `keys` sono inviate come tasti della riga in alto |
| Pausa | 0–60000 ms | Fra due azioni |
| Condizione (`when`) | Comando shell di guardia (timeout 10 s) | Exit 0 = continua, exit 1 = la catena finisce in silenzio (nessun errore), altro = errore |

Opzioni del pulsante: **conferma** (il primo tocco arma per 3 s, il secondo esegue) e
**mostra output** (l'output compare come avviso sul tablet; gli errori si vedono sempre).

### Azioni Mac (catalogo)

Modelli tipizzati che generano AppleScript; gli argomenti sono validati ed escapati sul
server (`lib/macos.ts`). L'editor mostra il catalogo (`GET /api/actions`) e può anche
mostrare lo script generato (`POST /api/macscript`).

| Gruppo | Azioni |
|---|---|
| `music` | `music.playpause`, `music.next`, `music.previous`, `music.volume` (livello 0–100) |
| `spotify` | `spotify.playpause`, `spotify.next`, `spotify.previous`, `spotify.volume` (livello 0–100) |
| `system` | `system.volume` (0–100), `system.volumeStep` (delta −100…100), `system.mute` (toggle/on/off), `system.notify` (titolo, messaggio), `system.darkMode` (toggle/dark/light), `system.sleepDisplay`, `system.lock` |
| `app` | `app.open`, `app.quit`, `app.hide` (nome app) |
| `ui` | `ui.menu` (app, menu, voce di menu) |
| `window` | `window.move` (x, y), `window.resize` (larghezza, altezza), `window.fullscreen` |

`ui.*`, `app.hide`, `window.*`, `system.darkMode` e `system.lock` passano da System Events
e quindi richiedono il permesso *Accessibilità*.

### Condizioni, errori ignorati e output fra azioni

- **`when`**: una guardia shell. Se vale «falso» (exit 1) la catena si ferma senza errore:
  il risultato resta `ok` e porta `stopped: true`.
- **Continua se fallisce** (`continueOnError`, su qualunque azione tranne `when`): se l'azione
  fallisce la catena prosegue; il passo è marcato `ignored`.
- **`$PAD_OUT`**: l'output dell'azione precedente, visibile alle azioni shell, AppleScript, Azione
  Mac e `when` come variabile d'ambiente (in AppleScript: `system attribute "PAD_OUT"`).
  Insieme a `$PAD_BUTTON` (id del pulsante) e, per i cursori, `$PAD_VALUE`.

### Pressione lunga, LED, cursori, pagine

- **Pressione lunga:** tenendo premuto ~0,5 s si eseguono le azioni «Pressione lunga» al posto del
  tocco (senza conferma: è già un gesto deliberato). Si vede dal **pallino sull'icona**; mentre
  tieni premuto una barra si riempie. Solo i pulsanti che hanno azioni di pressione lunga la offrono.
- **LED di stato:** un comando shell per pulsante, controllato ~ogni 2,5 s e dopo ogni azione.
  Exit 0 = acceso (il tasto si illumina e il LED in alto a destra diventa verde). Timeout (3 s) =
  stato ignoto, il LED non cambia. Il tablet non vede mai il comando, solo se il LED esiste.
- **Cursore** (tipo «Cursore» nell'editor): trascini lungo la traccia, il valore intero 0–100 arriva
  ai comandi in `$PAD_VALUE` (variabile d'ambiente, mai interpolata nella stringa) ~10 volte al
  secondo. «Leggi valore» deve stampare un numero 0–100: il cursore si riallinea al valore reale del
  Mac, ma non scavalca il dito né il tuo ultimo gesto (1,5 s).
- **Pagine:** swipe orizzontale o tab; la plancia ruota «a cubo». Lo swipe non agisce sui cursori.
  Con `prefers-reduced-motion` l'animazione è disattivata.

**Permesso Accessibilità** (scorciatoie, testo e azioni Mac via System Events): Impostazioni di
Sistema → Privacy e sicurezza → Accessibilità → aggiungi il programma che lancia `bun`
(es. Terminale). Senza, il pulsante fallisce e l'avviso lo spiega.

## Modello di sicurezza

Il server ascolta sulla LAN, e un pulsante può eseguire comandi sul Mac. Quindi:

- Il tablet può **solo premere pulsanti già definiti**: `GET /api/pad` non contiene mai i
  comandi, `POST /api/run/<id>` esegue solo ciò che sta in `data/pad.json`.
- **Editor, salvataggio, prova e catalogo azioni** (`/edit`, `/api/config`, `/api/test`,
  `/api/actions`, `/api/macscript`) rispondono solo se la connessione parte dal Mac stesso
  (loopback o uno dei suoi IP) **e** l'header `Host` è `localhost` o un IP del Mac (blocca il
  DNS rebinding). Dal Duet o da un altro dispositivo: 403.
- Le richieste POST/PUT con `Origin` di un altro sito sono rifiutate (CSRF).
- **Non c'è autenticazione sul pad**: chiunque sia sulla tua LAN può premere i pulsanti.
  Per i pulsanti pericolosi usa *conferma*; se la rete non è fidata, mettici davanti
  un firewall o dimmelo e aggiungiamo un PIN.

La prima volta macOS chiede se `bun` può accettare connessioni in entrata: concedi.

## Dati

`data/pad.json` è la sola fonte di verità (gitignored; alla prima accensione contiene
un pad d'esempio con azioni innocue). Ogni salvataggio è atomico e tiene la copia
precedente in `pad.json.bak`. Se il file è invalido il server non parte e non lo
sovrascrive. Lo puoi anche modificare a mano: il tablet si aggiorna da solo (polling
ogni 2,5 s su `/api/rev`, la revisione cambia a ogni salvataggio dall'editor).

## Struttura

```
server.ts          Bun.serve: routing, guardie, limiti
lib/config.ts      schema, validazione, seed, store atomico
lib/run.ts         esecuzione dei passi (timeout, albero di processi, output)
lib/macos.ts       catalogo delle azioni Mac (AppleScript generato)
lib/keys.ts        "cmd+shift+4" → AppleScript System Events
lib/guard.ts       loopback/Host/Origin
lib/state.ts       stato dei LED
public/pad.*       pad per il tablet
public/edit.*      editor
public/common.js   DOM helper + tile condiviso pad/editor
public/i18n.js     traduzioni (en/it)
tests/             bun test
```

## Limiti noti

- Su `http://IP-LAN` Chrome non espone il Wake Lock (serve https/localhost): per non far
  spegnere lo schermo del Duet regola il blocco schermo di ChromeOS.
- Se il Mac va in stop il pad segnala il puntino rosso in basso e riprova ogni 5 s.
- Un solo editor alla volta: l'ultimo salvataggio vince.
