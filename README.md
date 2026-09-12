# TerminalMCP

Server MCP che dà a un'IA **controllo completo di una shell** del sistema, più
un set di tool per leggere e modificare file in modo chirurgico.

Progettato con due obiettivi: **controllo totale** e **risparmio di token**.

- **Zero dipendenze.** Solo Node.js >= 18. Nessun `npm install`.
- **Windows, Linux, macOS.** Shell di sistema per default, oppure `bash`,
  Git Bash, `zsh`, `fish`, `cmd`, PowerShell, `pwsh`, WSL o un binario a scelta.
- **Un solo script per partire.** `./start.sh` o `start.cmd` (locale, stdio),
  `./start-http.sh` o `start-http.cmd` (remoto, HTTP).
- **Due trasporti.** stdio in locale; via HTTP sia Streamable HTTP
  (MCP 2025-06-18) che il legacy HTTP+SSE (MCP 2024-11-05), senza autenticazione.
- **26 tool in 11 gruppi**, accendibili a gruppi per non pagare token inutili.
- **Variabili lato server**: memorizzi un valore una volta e lo richiami con
  `${vars.nome}`, senza ripassarlo nella conversazione.
- **Skill incluso** che insegna al modello come usarlo spendendo pochi token.

---

## Avvio rapido

```bash
git clone <questo-repo> TerminalMCP
cd TerminalMCP

./start.sh --doctor        # Linux / macOS / Git Bash: verifica l'ambiente
start.cmd --doctor         # Windows
```

`--doctor` stampa piattaforma, shell rilevate, cwd e limiti attivi. Se va a
buon fine, il server è pronto: si avvia senza argomenti e parla MCP su stdio.

### Registrazione nel client MCP

```bash
node bin/terminalmcp.js --print-config
```

Stampa gli snippet già compilati con il percorso giusto. In sintesi:

**Claude Code** (una riga):
```bash
claude mcp add terminal -- node "/percorso/assoluto/TerminalMCP/bin/terminalmcp.js"
```

**Claude Desktop / Cursor** (`claude_desktop_config.json`, `.mcp.json`):
```json
{
  "mcpServers": {
    "terminal": {
      "command": "node",
      "args": ["C:\\percorso\\TerminalMCP\\bin\\terminalmcp.js"],
      "env": { "TERMINALMCP_SHELL": "gitbash" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "terminal": {
      "type": "stdio",
      "command": "node",
      "args": ["/percorso/TerminalMCP/bin/terminalmcp.js"]
    }
  }
}
```

### Installare lo skill

```bash
npm run install-skill              # -> ~/.claude/skills/terminalmcp
node scripts/install-skill.mjs --project   # -> ./.claude/skills/terminalmcp
```

---

## Trasporto remoto HTTP

Oltre a stdio (locale), il server può girare come servizio HTTP remoto.
**Non c'è autenticazione**: chi raggiunge la porta ha una shell completa sulla
macchina. Vedi [Esposizione e rischio](#esposizione-e-rischio) sotto.

```bash
./start-http.sh                  # Linux/macOS: 0.0.0.0:8787, raggiungibile da fuori
start-http.cmd                   # Windows: idem
PORT=9000 ./start-http.sh        # porta diversa

./start.sh --http                # solo locale (127.0.0.1:8787)
node bin/terminalmcp.js --http --host 0.0.0.0 --port 8787
```

Verifica che sia su:

```bash
curl http://<ip>:8787/health
```

### Endpoint

Vengono serviti entrambi i transport MCP contemporaneamente, così funziona sia
con i client attuali che con quelli vecchi.

| Metodo | Percorso | Cosa fa |
| --- | --- | --- |
| `POST` | `/mcp` | **Streamable HTTP** (MCP 2025-03-26 / 2025-06-18): invii un messaggio JSON-RPC, torna la risposta. |
| `GET` | `/mcp` | Apre uno stream SSE per i messaggi server→client. |
| `DELETE` | `/mcp` | Chiude la sessione. |
| `GET` | `/sse` | **Legacy HTTP+SSE** (MCP 2024-11-05): apre lo stream; il primo evento indica dove fare POST. |
| `POST` | `/messages?sessionId=…` | Legacy: invia un messaggio, la risposta arriva sullo stream SSE. |
| `GET` | `/health` o `/` | Stato, tool, sessioni e job attivi in JSON. |

### Registrazione nel client

```bash
node bin/terminalmcp.js --print-config --http --host 0.0.0.0 --port 8787
```

**Claude Code:**
```bash
claude mcp add --transport http terminal http://<ip>:8787/mcp
```

**Claude Desktop / Cursor / VS Code:**
```json
{ "mcpServers": { "terminal": { "type": "http", "url": "http://<ip>:8787/mcp" } } }
```

**Client che parlano solo il vecchio SSE:**
```json
{ "mcpServers": { "terminal": { "type": "sse", "url": "http://<ip>:8787/sse" } } }
```

### Sessioni e job

All'`initialize` il server assegna un `Mcp-Session-Id` e lo restituisce
nell'header; il client lo rimanda nelle richieste successive. La sessione
conserva la versione di protocollo negoziata, così client diversi possono
parlare revisioni diverse contemporaneamente. Le sessioni inattive scadono
dopo 30 minuti.

**Il registro dei job è invece condiviso tra tutte le sessioni**, ed è una
scelta: il server pilota *una* macchina, quindi un job avviato da un client
resta leggibile da un altro (o dallo stesso client dopo una riconnessione).
Con `shell_job {action:"list"}` vedi tutto quello che gira.

Per default un `Mcp-Session-Id` sconosciuto viene comunque servito, invece di
rispondere 404: tanto non c'è autenticazione, e così non si rompono i client
che dimenticano l'header. Con `--strict-sessions` si ottiene il comportamento
rigoroso (404 → il client rifà `initialize`).

### Comandi lunghi

I timeout lato server HTTP sono disattivati, quindi un `shell_exec` da dieci
minuti non viene troncato. Se hai un reverse proxy davanti che chiude le
risposte inattive, aggiungi `--sse-replies`: le risposte diventano stream SSE
con commenti keepalive ogni 15 secondi. In alternativa — ed è la scelta
migliore comunque — usa `shell_exec_async` e leggi con `shell_job`.

### Esposizione e rischio

Il default di bind è `127.0.0.1` proprio perché aprirsi è una decisione
esplicita. `start-http.sh` / `start-http.cmd` bindano `0.0.0.0` perché
esistono per l'uso remoto, e all'avvio il server lo scrive a chiare lettere.

Non c'è autenticazione, quindi **la porta è la credenziale**. Tenuto conto che
mi hai detto di non preoccuparmene, segnalo solo le due cose che costano poco
e cambiano molto:

- Non esporre la porta su Internet. Tienila su LAN, VPN (Tailscale,
  WireGuard) o un tunnel SSH: `ssh -L 8787:127.0.0.1:8787 utente@host` e poi
  puntare il client su `http://127.0.0.1:8787/mcp`, lasciando il server su
  `127.0.0.1`.
- Se ti serve davvero su una rete non fidata, mettici davanti un reverse proxy
  (Caddy/nginx) con TLS e Basic Auth: il server non ne sa nulla e funziona
  uguale.

Se un domani volessi restringere le capacità invece della rete, ci sono già
`allowedRoots`, `denyCommands`, `denyPaths` e `readOnly` (vedi
[Guardrail](#guardrail-opzionali-disattivi-per-default)).

---

## I tool

26 tool in 11 gruppi. Le definizioni dei tool stanno nel contesto del modello
**a ogni richiesta**, quindi i gruppi si accendono e spengono: vedi
[Profili](#profili-dei-tool).

### core — sempre attivo (9 tool)

| Tool | A cosa serve |
| --- | --- |
| `shell_exec` | Esegue un comando e aspetta: exit code, stdout, stderr. |
| `shell_exec_async` | Avvia un comando in background, restituisce subito un `job_id`. |
| `shell_job` | Gestisce i job: `list`, `status`, `output`, `wait`, `write`, `kill`, `remove`. |
| `shell_bulk` | **Molti comandi in una sola chiamata**, con delay, condizioni, retry, variabili. |
| `file_read` | Legge un file, un intervallo di righe, la coda, o solo le righe che matchano una regex. |
| `file_write` | Scrive un file intero (`overwrite`, `append`, `prepend`, `create_new`). |
| `file_edit` | Modifica *parti* di un file: più operazioni in una sola chiamata, atomiche. |
| `fs_list` | Elenca una directory, con profondità e filtro glob. |
| `shell_info` | Piattaforma, shell attiva e disponibili, config, guardrail, profilo attivo. |

### vars — sempre attivo (1 tool)

`vars` — variabili lato server riusabili tra chiamate: `set`, `get`,
`list`, `delete`, `clear`, `append`, `incr`, `load`, `save`. Sempre
attivo perché l'espansione `${vars.…}` lo è sempre. Vedi
[Variabili interne](#variabili-interne).

### search (2 tool)

| Tool | A cosa serve |
| --- | --- |
| `search_text` | Grep su tutto l'albero: regex o literal, solo le righe che matchano, con contesto opzionale. Salta `.git`/`node_modules`/build e i binari, rispetta `.gitignore`. Modalità `files_only` e `count_only` per spendere ancora meno. Con `replace` fa il find&replace su tutto il progetto (`dry_run` mostra il diff). |
| `search_files` | Trova file e directory per glob, nome, dimensione o data. Ordina per path, size o mtime. |

### git (1 tool)

`git` con azioni e output compattato. Lettura: `status`, `log`, `diff`,
`show`, `blame`, `branches`, `tags`, `remotes`, `stash_list`,
`file_history`, `current`, `root`, `config_get`. Scrittura: `add`,
`unstage`, `commit`, `checkout`, `branch_create`, `branch_delete`,
`merge`, `rebase`, `reset`, `revert`, `restore`, `stash`,
`stash_pop`, `tag_create`, `fetch`, `pull`, `push`, `apply`,
`clean`, `init`. Qualsiasi altra cosa: `action:"raw"` con `args`.

git viene invocato **direttamente, non tramite shell**: un messaggio di commit
con virgolette, newline o `$` non ha bisogno di alcun escaping.

### fs (1 tool)

`fs_op` — `copy`, `move`, `delete`, `mkdir`, `touch`, `stat`,
`chmod`, `symlink`, `readlink`, `hash` (md5/sha1/sha256/sha512),
`disk_usage` (cosa occupa spazio), `tree`. `delete` rifiuta una directory
non vuota senza `recursive:true`.

### archive (1 tool)

`archive` — `create`, `list`, `extract`, `gzip`, `gunzip` per zip,
tar, tar.gz e gzip. **ZIP e TAR sono implementati nel server** (Node ha solo
zlib), quindi funzionano identici su Windows, macOS e Linux senza dipendere da
un binario `tar`/`zip` installato. In estrazione i path che escono dalla
destinazione vengono rifiutati (zip-slip).

### sys (2 tool)

| Tool | A cosa serve |
| --- | --- |
| `sys_info` | `overview`, `cpu`, `memory`, `disk` (spazio libero per mount), `network`, `env`, `uptime`, `user`. |
| `proc` | `list` (filtro per nome, ordina per cpu/memoria), `tree`, `info`, `kill` (per pid, opzionalmente con i figli, o per nome — che richiede `confirm:true`). |

### net (2 tool)

| Tool | A cosa serve |
| --- | --- |
| `http_request` | Client HTTP(S): status, tempi, header, body. Il JSON viene indentato, i body lunghi troncati. `json`, `form`, `query`, `insecure`, `headers_only`. |
| `net` | `dns` (A/AAAA/MX/TXT/CNAME/NS/PTR/ALL), `tcp_check`, `listening` (porte aperte e di chi sono), `interfaces`, `ping`. |

### dev (3 tool)

| Tool | A cosa serve |
| --- | --- |
| `pkg` | Pilota il package manager che il progetto usa davvero, rilevandolo dal lockfile: npm, pnpm, yarn, bun, deno, pip, uv, poetry, pipenv, cargo, go, composer, bundler, maven, gradle, dotnet. Azioni: `detect`, `install`, `add`, `remove`, `run`, `scripts`, `list`, `outdated`. |
| `project_info` | **Orientarsi in un repo sconosciuto in UNA chiamata**: linguaggi per file e righe, package manager, dipendenze e framework rilevati, script disponibili, entry point, comandi probabili per test/build/lint, branch git e stato, file di configurazione. |
| `code` | `outline` (funzioni, classi, tipi di un file con i numeri di riga — da leggere *prima* del file), `imports`, `todos` (TODO/FIXME/HACK/XXX), `stats` (righe di codice per linguaggio). |

### data (3 tool)

| Tool | A cosa serve |
| --- | --- |
| `json_tool` | `get`, `set`, `delete`, `merge` (profondo), `keys`, `validate`, `format` su un file JSON o su testo inline. I path sono tipo `scripts.build` o `items[0].name`. Patcha un singolo path invece di riscrivere il documento. |
| `diff` | `files` (diff unificato tra due file), `text` (tra due stringhe), `apply` (applica una patch — i numeri di riga degli hunk vengono ritrovati per contesto, quindi la patch si applica anche se il file si è spostato). |
| `encode` | base64/hex/url/html encode e decode, `hash`, `uuid`, `random`, `jwt_decode` (firma **non** verificata), `timestamp` (epoch ↔ ISO). |

### watch (1 tool)

`watch` — `start` restituisce un `watch_id`, `poll` si blocca fino a
`wait_ms` in attesa di cambiamenti (una chiamata invece di un ciclo di
polling), `list`, `stop`. Gli eventi vengono raggruppati per path, così un
salvataggio che ne genera tre viene riportato una volta.

---

## Variabili interne

Un valore catturato può restare sul server. Lo memorizzi una volta, poi lo
richiami come `${vars.<nome>}` nelle chiamate successive: il valore non
ripassa mai dalla conversazione.

```
shell_exec { command: "git rev-parse --short HEAD", assign: "sha" }
shell_exec { command: "docker build -t app:${vars.sha} ." }
```

La seconda chiamata non spende un token sullo sha. È esattamente il punto.

### Il tool `vars`

| Azione | Cosa fa |
| --- | --- |
| `set` | Memorizza un valore (qualsiasi tipo JSON). Una stringa viene essa stessa espansa, così puoi comporre da altre variabili. |
| `get` | Legge un valore (o più, con `names`). |
| `list` | Nomi, tipi, dimensioni e un'anteprima — **non** i valori interi. |
| `delete` / `clear` | Rimuove una variabile o tutte (`clear` richiede `confirm:true`). |
| `append` / `incr` | Accoda a una stringa o array; incrementa un numero. |
| `load` / `save` | Carica un file in una variabile (`json:true` per parsarlo) o scrive una variabile su file. |

`list` mostra volutamente anteprime e non valori: riversare lo store
annullerebbe il risparmio. Usa `get` quando devi davvero leggere qualcosa.

### Catturare senza mai vedere il valore

Tre tool scrivono direttamente nello store:

```
shell_exec   { command: "...", assign: "nome" }    lo stdout ripulito
http_request { url: "...", assign: "body" }        il corpo della risposta
shell_bulk   steps: [{ ..., assign: "nome" }]      per singolo step
```

Un `assign` in `shell_bulk` è visibile agli step successivi dello stesso run
**e** resta disponibile per le chiamate seguenti. E ogni step legge già tutto
lo store, quindi non serve passargli valori che ci sono già.

```json
{"steps": [
  {"id": "ver", "command": "node -p \"require('./package.json').version\"", "assign": "version"},
  {"command": "gh release create v${vars.version}", "when": "prev.ok"}
]}
```

### Dove `${...}` viene espanso

Nei comandi, in `cwd`, nei valori di `env`, in `stdin`, nei path di file e
directory, negli URL, negli header e nei query param delle richieste, nei
messaggi e nei ref di git, nei nomi dei pacchetti, e in ogni step di
`shell_bulk`.

**Non** nel contenuto dei file, nei pattern regex e nei corpi delle patch: un
template literal JavaScript, un workflow GitHub Actions e una regex contengono
legittimamente `${...}`, e riscriverli sarebbe peggio che chiedere.

Disponibile anche `${env.PATH}` per l'ambiente del server.

### Non litiga con la shell

`${...}` è **anche** sintassi shell. Tutto ciò che non nomina una variabile
che il server conosce viene passato **intatto**, quindi `echo ${HOME}`,
`${PATH%%:*}` e `${#arr}` arrivano a bash come sono. Solo i nomi che il
server conosce vengono sostituiti.

Se referenzi un `${vars.qualcosa}` che non esiste, il testo passa letterale e
il risultato porta una nota che lo dice — così capisci di aver sbagliato il
nome, invece di ritrovarti un valore vuoto senza sapere perché.

`${...}` resta l'escape esplicito per un `${...}` letterale.

*(Questo era un bug reale: prima della funzione, `shell_bulk` svuotava
`${HOME}` e andava in errore su `${PATH%%:*}`. Ora entrambi sopravvivono, e
c'è un test che lo verifica attraverso il server vero.)*

### Segreti

```
vars { action: "set", name: "token", value: "...", secret: true }
http_request { url: "...", headers: { Authorization: "Bearer ${vars.token}" } }
```

Un segreto funziona in ogni punto in cui funziona `${vars.…}` ma non viene
mai restituito: `list` mostra `(secret)`, `get` lo maschera a meno di
`reveal:true`, e non viene scritto nel file dello store (a meno di
`persistSecrets`). Memorizzi un token una volta e lo usi senza che riappaia
nella conversazione. Anche l'audit log lo sostituisce con `<secret>`.

### Cosa conviene tenerci

**Sì**: commit sha, numeri di versione, id restituiti da un'API, una base URL,
un token, un path scoperto, un contatore tra retry, un blob JSON da
interrogare più volte.

**No**: qualsiasi cosa grossa. C'è un tetto per variabile (1MB di default). Per
un payload pesante, scrivilo su file e tieni il **path** in una variabile.

### Ciclo di vita

Lo store vive quanto il processo del server ed è condiviso tra tutte le
sessioni (come il registro dei job, e per lo stesso motivo: il server pilota
*una* macchina). Con `varsFile` viene specchiato su disco e sopravvive a un
riavvio; la scrittura è atomica (tmp + rename) e un file corrotto viene
segnalato senza impedire l'avvio.

`shell_info` riporta quante variabili sono impostate.

---

## Profili dei tool

Le definizioni dei tool costano token **a ogni richiesta**, non una volta sola.
Misurato sul server:

| Profilo | Tool | Token di schema per richiesta |
| --- | --- | --- |
| `core` | 10 | ~4.800 |
| `ops` | 18 | ~8.500 |
| `dev` | 20 | ~9.200 |
| `all` (default) | 26 | ~11.500 |

```bash
node bin/terminalmcp.js --tools core          # solo shell, job, bulk, file
node bin/terminalmcp.js --tools dev           # core + search, git, fs, dev, data
node bin/terminalmcp.js --tools ops           # core + search, fs, archive, sys, net
node bin/terminalmcp.js --tools core,git,search
node bin/terminalmcp.js --tools all,-watch,-archive
```

`core` e `vars` sono sempre inclusi. Un profilo di soli `-gruppo` significa "tutto
tranne quelli". Puoi anche metterlo in config (`"tools": "dev"`) o in
`TERMINALMCP_TOOLS`.

Per vedere il costo dei gruppi e cosa è attivo:

```bash
node bin/terminalmcp.js --list-tools
node bin/terminalmcp.js --doctor
```

Anche `shell_info` lo riporta al modello a runtime, così la decisione di
tagliare è informata invece che a sensazione. E niente va perso comunque:
quello che non è esposto come tool resta raggiungibile con `shell_exec`.

---

### `shell_bulk`: il cuore del risparmio token

Ogni chiamata MCP rispedisce la conversazione al modello. Cinque `shell_exec`
costano circa cinque volte i token di un `shell_bulk` con cinque step.

Ogni step supporta:

| Campo | Effetto |
| --- | --- |
| `id` | Nome dello step, referenziabile come `step.<id>` nelle condizioni successive. |
| `when` | Esegue solo se la condizione è vera. |
| `expect_exit` | Quali exit code contano come successo: numero, array, o `"any"`. |
| `on_failure` | `"stop"` (default) o `"continue"`. |
| `retry` | `{ count, delay_ms }` per comandi instabili. |
| `delay_before_ms` / `delay_after_ms` | Attese, es. mentre un servizio parte. |
| `assign` | Cattura l'output in `vars.<nome>`, usabile dagli step seguenti. |
| `capture` | Quanto output restituire: `full`, `head`, `tail`, `on_failure`, `none`. |
| `cwd`, `shell`, `env`, `timeout_ms`, `stdin` | Override per singolo step. |

**Condizioni.** Scorciatoie: `always`, `never`, `prev_success`,
`prev_failure`, `all_success`, `any_failure`. Oppure un'espressione:

```
prev.ok
prev.exit == 0 && contains(prev.stdout, "0 failing")
step.build.ok && !step.lint.ok
steps[0].exit == 0
vars.branch == "main"
failed_count == 0
```

Funzioni disponibili: `contains`, `icontains`, `matches`, `empty`, `exists`,
`len`, `lines`, `first_line`, `last_line`, `int`, `num`, `lower`, `upper`,
`trim`. Operatori: `== != > < >= <= && || !`, `=~` e `!~` per regex, e
`and` / `or` come parole.

**Interpolazione.** `${...}` valuta le stesse espressioni dentro `command`,
`cwd` e `stdin`. Per un `${...}` letterale da passare alla shell: `$${...}`.

Esempio completo — testa, builda e fa deploy solo se tutto è verde:

```json
{
  "cwd": "/srv/app",
  "stop_on_failure": false,
  "capture": "on_failure",
  "steps": [
    { "id": "deps",   "command": "npm ci" },
    { "id": "lint",   "command": "npm run lint", "on_failure": "continue" },
    { "id": "test",   "command": "npm test", "timeout_ms": 600000 },
    { "id": "build",  "command": "npm run build", "when": "step.test.ok" },
    { "id": "deploy", "command": "./deploy.sh",
      "when": "step.build.ok && step.lint.ok",
      "retry": { "count": 2, "delay_ms": 5000 } },
    { "id": "smoke",  "command": "curl -fsS localhost:8080/health",
      "when": "step.deploy.ok", "delay_before_ms": 3000,
      "retry": { "count": 5, "delay_ms": 2000 } }
  ]
}
```

`capture: "on_failure"` è il guadagno più grosso su pipeline come questa:
silenzio finché tutto passa, output completo esattamente dove si è rotto.

### Job in background

```
shell_exec_async { command: "npm run build", name: "build" }    -> job_id=job1
shell_job { action: "wait",   job_id: "job1", wait_ms: 60000 }   blocca fino all'uscita
shell_job { action: "output", job_id: "job1", offset: 4096 }     solo ciò che è nuovo
```

`action: "output"` con `wait_ms` si blocca finché non arriva output nuovo:
una sola richiesta al posto di un ciclo di polling. Il `next_offset`
restituito va ripassato come `offset`, così non si rileggono byte già visti.
Con `interactive: true` lo stdin resta aperto e si scrive con
`action: "write"`.

### Leggere e modificare file

```
file_read { path, match: "function handleLogin", context: 5 }   solo le righe utili
file_read { path, start_line: 120, end_line: 180 }              un intervallo
file_read { path, tail_lines: 50 }                              la coda di un log
file_read { path, start_line: -30 }                             le ultime 30 righe
```

L'output è numerato (`  12│contenuto`), così le modifiche si pianificano
direttamente da una sola lettura. I file binari vengono segnalati, non
riversati nel contesto (`encoding: "base64"` se servono i byte).

`file_edit` applica **più operazioni in una chiamata**:

```json
{ "path": "src/app.js", "ops": [
  { "type": "replace_lines", "start_line": 42, "end_line": 45,
    "content": "  const port = 8080;", "expect_match": "const port" },
  { "type": "replace_text", "old": "DEBUG = true", "new": "DEBUG = false" },
  { "type": "insert_after", "start_line": 1, "content": "'use strict';" },
  { "type": "delete_lines", "start_line": 100, "end_line": 110 }
]}
```

Tre regole che rendono il tutto prevedibile:

1. **I numeri di riga si riferiscono sempre al file originale** e gli
   intervalli non possono sovrapporsi. Quindi si pianifica tutto da una sola
   `file_read`, senza aritmetica su righe che si spostano.
2. È **tutto-o-niente**: se una op fallisce, il file non viene toccato.
3. `replace_text` fallisce se il testo non compare esattamente una volta
   (`all: true` per sostituirle tutte, `expect_count: n` se sono più di una).
   `expect_match` fa lo stesso lavoro per le op basate su riga.

`dry_run: true` mostra il diff senza scrivere.

Tipi di op: `replace_lines`, `delete_lines`, `insert_before`, `insert_after`,
`replace_text`, `regex_replace`, `append`, `prepend`.

---

## Configurazione

Precedenza, dalla più forte: parametri della singola chiamata → variabili
d'ambiente `TERMINALMCP_*` → file di configurazione → default.

Il file viene cercato in quest'ordine:

1. `$TERMINALMCP_CONFIG`
2. `./terminalmcp.config.json`
3. `./.terminalmcp.json`
4. `~/.terminalmcp/config.json`

Parti da `terminalmcp.config.example.json` (i commenti `//` sono ammessi):

```bash
cp terminalmcp.config.example.json terminalmcp.config.json
```

### Scegliere la shell

```json
{ "shell": "auto" }
```

`auto` usa la shell di sistema: `pwsh` → `powershell` → `cmd` su Windows,
`$SHELL` poi `bash` → `zsh` → `sh` altrove. Alternative:

| Valore | Shell |
| --- | --- |
| `"bash"` | Bash (su Windows trova Git Bash) |
| `"gitbash"` | Git Bash, solo Windows |
| `"zsh"`, `"fish"`, `"sh"` | le rispettive shell POSIX |
| `"cmd"` | `cmd.exe` |
| `"powershell"` | Windows PowerShell 5.x |
| `"pwsh"` | PowerShell 7+ |
| `"wsl"` | bash dentro WSL |
| `"C:/Program Files/Git/bin/bash.exe"` | qualsiasi percorso assoluto |

Shell personalizzate, poi selezionabili per nome (anche per singola chiamata):

```json
{
  "shells": {
    "docker": { "command": "docker", "args": ["exec", "-i", "web", "sh", "-c"] }
  }
}
```

Su Windows i comandi `cmd` e PowerShell passano per un file script temporaneo:
gli script multi-riga e le virgolette funzionano senza sorprese di quoting.

### Opzioni principali

| Campo | Default | Significato |
| --- | --- | --- |
| `shell` | `"auto"` | Shell da usare. |
| `login` | `false` | Shell di login (`-lc`), così valgono alias e PATH di `~/.profile`. |
| `cwd` | dir di avvio | Working directory di default. |
| `timeoutMs` | `120000` | Timeout per comando; uccide **tutto l'albero** di processi. `0` = illimitato. |
| `maxOutputBytes` | `16000` | Tetto di byte per stream restituito (~4 byte per token). |
| `maxBufferBytes` | `8388608` | Buffer in memoria per stream nei job. |
| `env` | `{}` | Variabili d'ambiente iniettate in ogni comando. |
| `keepAnsi` | `false` | Mantiene i codici colore ANSI (costano token). |
| `maxJobs` | `32` | Job in background contemporanei. |
| `jobRetentionMs` | `1800000` | Quanto restano in memoria i job finiti. |
| `varsFile` | `null` | Specchia lo store delle variabili su questo file. `null` = solo memoria. |
| `persistSecrets` | `false` | Scrive anche le variabili `secret` su quel file. |
| `maxVars` | `200` | Quante variabili si possono memorizzare. |
| `maxVarBytes` | `1048576` | Tetto per singola variabile. |
| `maxVarsTotalBytes` | `8388608` | Tetto complessivo dello store. |

### Guardrail (opzionali, disattivi per default)

Il server nasce per dare accesso completo, quindi di default non limita nulla.
Se serve restringerlo:

| Campo | Effetto |
| --- | --- |
| `allowedRoots` | I tool su file non possono uscire da queste directory (blocca anche le fughe via symlink). |
| `denyCommands` | Regex; un comando che matcha viene rifiutato. |
| `denyPaths` | Regex; una scrittura su un path che matcha viene rifiutata. |
| `readOnly` | Blocca ogni scrittura e ogni esecuzione di comandi. |
| `logFile` | Scrive una riga JSONL di audit per ogni chiamata. |

Un rifiuto torna al modello come `Policy: ...`, così capisce che è una scelta
dell'operatore e non un errore da aggirare.

### Variabili d'ambiente

`TERMINALMCP_SHELL`, `TERMINALMCP_CWD`, `TERMINALMCP_TIMEOUT_MS`,
`TERMINALMCP_MAX_OUTPUT_BYTES`, `TERMINALMCP_LOGIN`, `TERMINALMCP_KEEP_ANSI`,
`TERMINALMCP_READ_ONLY`, `TERMINALMCP_LOG_FILE`, `TERMINALMCP_ALLOWED_ROOTS`,
`TERMINALMCP_CONFIG`, `TERMINALMCP_TOOLS`, `TERMINALMCP_VARS_FILE`,
`TERMINALMCP_HTTP`, `TERMINALMCP_HTTP_HOST`,
`TERMINALMCP_HTTP_PORT`, `TERMINALMCP_HTTP_PATH`, `TERMINALMCP_HTTP_CORS`.

### Opzioni da riga di comando

```
node bin/terminalmcp.js --help
```

`--cwd`, `--shell`, `--config`, `--timeout-ms`, `--max-output-bytes`,
`--login`, `--read-only`, `--allowed-root`, `--log-file`, `--tools`,
`--vars-file`, `--persist-secrets`, `--max-vars`, `--max-var-bytes`.

Per il trasporto HTTP: `--http`, `--host`, `--port`, `--path`, `--no-cors`,
`--strict-sessions`, `--sse-replies`, `--max-body-bytes`.

Comandi: `--doctor`, `--print-config`, `--list-tools`, `--help`, `--version`.

---

## Come risparmia token

1. `shell_bulk` invece di tanti `shell_exec`: un round-trip invece di N.
2. `capture: "on_failure"` / `"none"` sugli step di cui non serve l'output.
3. `project_info` una volta invece di esplorare il repo a mano.
4. `search_text` per **trovare** il codice, invece di leggere file per cercarci
   dentro. `files_only` e `count_only` costano ancora meno.
5. `code outline` prima di leggere un file che non conosci.
6. `file_read` con `match`, un intervallo o `tail_lines`, non il file intero.
7. `file_edit` con più op invece di una chiamata per modifica; `search_text`
   con `replace` per la stessa modifica su molti file.
8. `json_tool` per patchare un singolo path invece di rileggere e riscrivere
   tutto il JSON.
9. `git diff stat:true` e `git log` compatto invece di patch che non leggerai.
10. Output ripulito: ANSI rimossi, spazi di fine riga tolti, righe vuote
    consecutive compattate.
11. Troncamento **al centro**, tenendo testa e coda (gli errori stanno in fondo),
    con nota sui byte omessi.
12. Sezioni vuote omesse: niente `stderr: (vuoto)`.
13. `quiet: true` su `shell_exec` quando basta l'exit code.
14. Letture incrementali dei job via `offset`: i byte già visti non tornano.
15. Un solo tool con `action` copre molte operazioni, invece di un tool per
    operazione: `git` da solo sostituirebbe 20 tool distinti.
16. **Variabili lato server**: `assign` un valore invece di trascinarlo nella
    conversazione, poi `${vars.nome}`.
17. Descrizioni dei tool volutamente compatte — stanno nel contesto a ogni
    richiesta — e i **profili** per non pagare i gruppi che non usi.

---

## Test

```bash
npm test              # 383 asserzioni in tutto
npm run test:smoke    # protocollo stdio, exec, job, bulk, file, profili (97)
npm run test:guards   # guardrail: readOnly, allowedRoots, deny*        (14)
npm run test:tools    # i tool estesi: search, git, fs, archive, ...    (156)
npm run test:vars     # variabili, interpolazione, segreti, persistenza (67)
npm run test:http     # trasporto HTTP: streamable + legacy SSE         (49)
```

I test avviano il server vero e ci parlano in MCP — su stdio per la suite
principale, su HTTP reale (sessioni, SSE, CORS, batch, 413) per quella del
trasporto. Quindi verificano anche handshake, framing JSON-RPC e negoziazione
di protocollo, non solo la logica interna.

---

## Architettura

```
bin/terminalmcp.js   CLI: argomenti, --doctor, --print-config, avvio
src/server.js        JSON-RPC 2.0, metodi MCP, sessioni, audit log
src/http.js          trasporto HTTP: Streamable HTTP + legacy HTTP+SSE
src/tools/index.js   registry: gruppi, profili, costo in token
src/tools/interpolate.js  quali campi ammettono `${...}`, dichiarati in un posto solo
src/tools/vars.js    vars
src/tools/core.js    shell, job, bulk, file read/write/edit
src/tools/search.js  search_text, search_files
src/tools/git.js     git
src/tools/fsops.js   fs_op
src/tools/archive.js archive
src/tools/sys.js     sys_info, proc
src/tools/net.js     http_request, net
src/tools/dev.js     pkg, project_info, code
src/tools/data.js    json_tool, diff, encode
src/tools/watch.js   watch
src/exec.js          spawn, timeout, kill dell'albero di processi, buffer
src/jobs.js          registro dei job in background
src/bulk.js          esecuzione sequenziale con condizioni, retry, variabili
src/expr.js          mini-linguaggio per `when` e `${...}` (parser dedicato, nessun eval)
src/diff.js          diff per righe (LCS) e applicazione di patch unificate
src/glob.js          matching glob e `.gitignore`
src/walk.js          un solo walker per tutti i tool che scandiscono l'albero
src/archive.js       ZIP e TAR implementati a mano (Node ha solo zlib)
src/vars.js          store delle variabili: TTL, tetti, segreti, persistenza atomica
src/files.js         file_read / file_write / file_edit / fs_list
src/shells.js        rilevamento shell e strategia di invocazione per piattaforma
src/config.js        caricamento config e precedenze
src/guards.js        guardrail opzionali
src/format.js        pulizia e troncamento dell'output
skills/terminalmcp/  lo skill per il modello
```

Note d'implementazione:

- Il protocollo MCP è implementato a mano (JSON-RPC 2.0, messaggi separati da
  newline su stdio) per restare a zero dipendenze: si clona e parte.
- `stdout` porta **solo** il protocollo; ogni diagnostica va su `stderr`.
- Su HTTP la risposta è JSON normale quando il client accetta JSON — i client
  mandano `Accept: application/json, text/event-stream` su ogni richiesta, e
  avvolgere ogni risposta breve in un event stream non porta niente. Lo stream
  SSE si usa quando il client non accetta JSON, o con `--sse-replies`.
- Le richieste non si bloccano a vicenda: un `shell_exec` lungo non impedisce
  un `shell_job` in parallelo.
- I timeout uccidono l'intero gruppo di processi (`process.kill(-pid)` su
  POSIX, `taskkill /T /F` su Windows), non solo il processo padre.
- `${...}` e `when` usano un parser dedicato: nessun `eval`, nessun accesso a
  funzioni arbitrarie.

---

## Da sapere

- **Ogni comando parte in una shell nuova.** `cd`, `export` e `source` non si
  propagano tra chiamate né tra step: usa `cwd`, `env`, oppure concatena
  dentro un unico comando (`cd x && make`).
- Il server ha i permessi dell'utente che lo avvia. Non c'è sandbox: è
  intenzionale, ed è il motivo per cui esistono i guardrail.
- L'output è troncato al centro a `maxOutputBytes`. Se ti serve davvero il
  mezzo di un log lungo, alzalo o leggi il file con `tail_lines`.

## Roadmap

Feature già previste per i prossimi passi: step paralleli in `shell_bulk`,
sessioni di shell persistenti (stato `cd`/`export` conservato), un client
SQL, e — se servisse — un token opzionale sul trasporto HTTP.

## Licenza

MIT
