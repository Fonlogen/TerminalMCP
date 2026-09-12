# TerminalMCP

Server MCP che dà a un'IA **controllo completo di una shell** del sistema, più
un set di tool per leggere e modificare file in modo chirurgico.

Progettato con due obiettivi: **controllo totale** e **risparmio di token**.

- **Zero dipendenze.** Solo Node.js >= 18. Nessun `npm install`.
- **Windows, Linux, macOS.** Shell di sistema per default, oppure `bash`,
  Git Bash, `zsh`, `fish`, `cmd`, PowerShell, `pwsh`, WSL o un binario a scelta.
- **Un solo script per partire.** `./start.sh` o `start.cmd`.
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

## I tool

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
| `shell_info` | Riporta piattaforma, shell attiva, shell disponibili, config e guardrail. |

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
`TERMINALMCP_CONFIG`.

### Opzioni da riga di comando

```
node bin/terminalmcp.js --help
```

`--cwd`, `--shell`, `--config`, `--timeout-ms`, `--max-output-bytes`,
`--login`, `--read-only`, `--allowed-root`, `--log-file`, e i comandi
`--doctor`, `--print-config`, `--list-tools`.

---

## Come risparmia token

1. `shell_bulk` invece di tanti `shell_exec`: un round-trip invece di N.
2. `capture: "on_failure"` / `"none"` sugli step di cui non serve l'output.
3. `file_read` con `match`, un intervallo o `tail_lines`, non il file intero.
4. `file_edit` con più op invece di una chiamata per modifica.
5. Output ripulito: ANSI rimossi, spazi di fine riga tolti, righe vuote
   consecutive compattate.
6. Troncamento **al centro**, tenendo testa e coda (gli errori stanno in fondo),
   con nota sui byte omessi.
7. Sezioni vuote omesse: niente `stderr: (vuoto)`.
8. `quiet: true` su `shell_exec` quando basta l'exit code.
9. Letture incrementali dei job via `offset`: i byte già visti non tornano.
10. Descrizioni dei tool volutamente compatte — stanno nel contesto a ogni richiesta.

---

## Test

```bash
npm test              # 102 asserzioni: protocollo, exec, job, bulk, file, guardrail
npm run test:smoke    # solo il grosso della suite
npm run test:guards   # solo i guardrail
```

I test avviano il server vero e ci parlano in MCP su stdio, quindi verificano
anche l'handshake e il framing JSON-RPC.

---

## Architettura

```
bin/terminalmcp.js   CLI: argomenti, --doctor, --print-config, avvio
src/server.js        JSON-RPC 2.0 su stdio, metodi MCP, audit log
src/tools.js         definizioni dei 9 tool e dispatch
src/exec.js          spawn, timeout, kill dell'albero di processi, buffer
src/jobs.js          registro dei job in background
src/bulk.js          esecuzione sequenziale con condizioni, retry, variabili
src/expr.js          mini-linguaggio per `when` e `${...}` (parser dedicato, nessun eval)
src/files.js         file_read / file_write / file_edit / fs_list
src/shells.js        rilevamento shell e strategia di invocazione per piattaforma
src/config.js        caricamento config e precedenze
src/guards.js        guardrail opzionali
src/format.js        pulizia e troncamento dell'output
skills/terminalmcp/  lo skill per il modello
```

Note d'implementazione:

- Il protocollo MCP è implementato a mano (JSON-RPC 2.0, messaggi separati da
  newline) per restare a zero dipendenze: si clona e parte.
- `stdout` porta **solo** il protocollo; ogni diagnostica va su `stderr`.
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
sessioni di shell persistenti (stato `cd`/`export` conservato), ricerca
testuale su più file, watch di file, e trasporto HTTP/SSE oltre a stdio.

## Licenza

MIT
