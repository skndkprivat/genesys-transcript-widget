# Genesys Cloud Transcript & AI Resumé Widget

Interaction Widget til Genesys Cloud, der viser samtalens transskription og genererer et AI-resumé, som agenten kan sætte ind i wrap-up-noter **inden** der trykkes *Done* — også når kunden har lagt på.

Flad filstruktur (`index.html` + `app.js`) — kan uploades direkte via GitHub-webinterfacet og hostes på GitHub Pages.

## To måder at få transskriptionen

| Metode | Hvornår | Krav |
|---|---|---|
| **Realtid** (Notifications API, topic `v2.conversations.{id}.transcription`) | Under samtalen — teksten strømmer ind løbende | Voice Transcription aktiveret på kø/flow. Slå **Low Latency Transcription** til (Admin → Speech and Text Analytics → Settings) for 3-5 sek. latenstid i stedet for ~35 sek. Permission: `conversation:transcription:view` |
| **Hent** (`GET /api/v2/speechandtextanalytics/.../transcripturl`) | I efterbehandling (ACW), efter kunden har lagt på. Kan tage 1-2 min. om at blive klar | Voice Transcription aktiveret. Permissions: `speechAndTextAnalytics:data:view`, `recording:recording:view` |

Anbefaling: start **Realtid** når samtalen begynder — så er hele transskriptionen klar i widget'en i samme sekund kunden lægger på, og resuméet kan genereres med det samme. Widget'en registrerer selv `SESSION_ENDED` og fortæller agenten, at resuméet kan laves.

## AI-resumé

Understøtter tre udbydere med egne API-nøgler (gemmes kun i browserens localStorage, sendes direkte til udbyderen — ingen backend):

- **OpenAI** (`gpt-4o-mini` som standard)
- **Google Gemini** (`gemini-2.0-flash`)
- **Anthropic Claude** (`claude-sonnet-4-5`)

**Fokuspunkter**: fritekstfelt hvor man definerer, hvad der er vigtigt i samtalerne (aftaler, beløb, sagsnumre, klager, GDPR-emner …). Teksten injiceres i AI-prompten. Resumésprog kan vælges uafhængigt af UI-sprog.

UI-sprog: dansk, engelsk, fransk, tysk — vælges automatisk ud fra `{{gcLangTag}}` eller manuelt.

## Opsætning i Genesys Cloud

### 1. OAuth-klient
Admin → Integrations → OAuth → **Add Client**
- Grant type: **Token Implicit Grant (Browser)**
- Authorized redirect URI: `https://<dit-github-brugernavn>.github.io/<repo>/index.html` (og evt. uden `index.html`)
- Scope: `conversations`, `speech-and-text-analytics`, `notifications`
- Kopiér Client ID ind i widget'ens Opsætning-fane.

### 2. Interaction Widget-integration
Admin → Integrations → **Add Integration** → *Interaction Widget*
- Application URL:
  ```
  https://<bruger>.github.io/<repo>/index.html?conversationId={{gcConversationId}}&langTag={{gcLangTag}}
  ```
- Iframe sandbox options: `allow-scripts,allow-same-origin,allow-forms,allow-popups`
- Iframe feature permissions: `clipboard-write`
- Communication type filtering: `call` (eller tom for alle)
- Aktivér integrationen og tildel den til de relevante grupper.

### 3. Transskription
- Admin → Conversation Intelligence → Speech and Text Analytics → Settings:
  - Voice Transcription: **Enabled** (Queue configuration eller Flow action)
  - Low Latency Transcription: **Enabled** (anbefalet til realtid)
- Sørg for at "Voice Transcription" er slået til på de relevante køer.
- Bemærk: kræver Cloud-baseret Edge (Genesys Cloud Voice eller BYOC Cloud). BYOC Premises understøttes ikke til realtidstopic'et.

### 4. Permissions (agent-rollen)
- `conversation:transcription:view` (realtid — OBS: ikke divisionsbegrænset)
- `speechAndTextAnalytics:data:view` + `recording:recording:view` (hent)

## Deployment (GitHub Pages)
1. Opret repo, upload `index.html`, `app.js`, `README.md` via browseren.
2. Settings → Pages → Deploy from branch → `main` / root.
3. URL'en bruges i OAuth redirect og Interaction Widget-konfigurationen.

## Sådan ser du hvilken model der bruges

- Under fanen **Opsætning** har hver udbyder sit eget modelfelt (`modelOpenai`, `modelGemini`, `modelClaude`, `modelOllama`) — det er dét felt der reelt sendes med i AI-kaldet, uanset om kaldet går direkte, via proxy eller via Data Action.
- Statuslinjen efter et resumé viser udbyder + svartid (fx `Claude · 2.3s`), men ikke selve modelnavnet.
- **Log-fanen** er det bedste sted at se det: hvert AI-kald logges som `AI call: <provider> via <direct|proxy|data-action>, model <navn>, prompt N chars`, og svaret som `AI response: <provider>, model <navn>, N chars, N ms` — så du kan se både hvilken model der blev bedt om, og om den nåede at svare (v1.4.2+).
- Ved **Sammenlign udbydere** vises resultaterne under overskrifter pr. udbyder + svartid; modellen er den, der stod i det pågældende felt på Opsætning-fanen på kaldetidspunktet.
- Ved Data Action-kald sendes modelnavnet med i requesten (`${input.model}`) og kan verificeres i Genesys' egen Data Action-logning, hvis I vil se hvad der reelt blev modtaget server-side.

## Fejlsøgning af transskriptions-læsning

Brug altid **Log-fanen** først (knapper til at kopiere/gemme/rydde loggen) — den viser hele forløbet med tidsstempler, alle Genesys-kald (`${method} ${path}` / `← ${status} ${path}`) og WebSocket-status.

**Realtid (WebSocket) virker ikke:**
1. Tjek loggen for `Notification channel created` og `WebSocket open — subscribed to v2.conversations.<id>.transcription`. Mangler disse, er `conversationId` eller token forkert — tjek feltet på Opsætning-fanen.
2. WebSocket åben, men ingen tekst → transskription er sandsynligvis ikke aktiveret på køen/flowet (Admin → Conversation Intelligence → Speech and Text Analytics → Settings → Voice Transcription).
3. `401` i loggen → token udløbet, log ud/ind igen.
4. WebSocket lukker med det samme (`WebSocket closed (code ...)`) → mangler permission `conversation:transcription:view`, eller samtalen kører på BYOC Premises (ikke understøttet til realtidstopic'et — kræver Cloud-baseret Edge).
5. Høj latenstid (~35 sek. i stedet for 3-5 sek.) → **Low Latency Transcription** er ikke slået til i Settings.
6. `SESSION_ENDED` ses for tidligt i loggen → samtalen er reelt afsluttet, eller `conversationId` peger på en allerede afsluttet session.

**Hent-metoden (transcripturl) virker ikke:**
1. Tom besked / ingen fraser fundet → `transcripturl` er endnu ikke klar (kan tage 1-2 min. efter kunden har lagt på) — prøv igen om lidt.
2. `Genesys 403` i loggen → mangler `speechAndTextAnalytics:data:view` og/eller `recording:recording:view`.
3. `Genesys 404` på `/transcripturl` for alle communication-id'er → Voice Transcription var ikke aktiveret på samtalen, eller det er den forkerte `conversationId`.

## Se efterfølgende om AI-resuméet nåede at blive færdigt (fx ved ACW-timeout)

Hvis wrap-up (ACW) har en timeout — fx 20 sek. — og agenten (eller Genesys) lukker interaktionen/widget'en før resuméet er færdigt, er billedet efterfølgende afhængigt af, hvilken vej AI-kaldet gik:

- **Log-fanen alene rækker ikke** — `LOGBUF` ligger i browserens hukommelse for den aktuelle widget-instans, men fra og med **v1.4.3** spejles hver logline også løbende til `localStorage` (nøgle `gcTranscriptWidgetLog`), så den overlever at iframen lukkes/genindlæses (interaktionen afsluttes, ACW-timeout udløber, agenten klikker Done). Næste gang widget'en åbnes (i samme browser), vises knappen **"Hent forrige log"** i Log-fanen automatisk, hvis der er en gemt session — den downloader forrige samtales fulde log som tekstfil, inkl. tidsstempel og conversationId.
- Kig efter parret `AI call: ... model X ...` / `AI response: ... model X, N ms`. Mangler `AI response`-linjen efter et `AI call`, nåede kaldet ikke at svare, før loggen blev afbrudt eller widget'en lukket — dvs. et reelt timeout/afbrud.
- **Data Action-vejen har derudover et serverside-spor**: Genesys logger selv eksekveringen af integrationens Data Action (Admin → Integrations → Actions → den pågældende action, evt. via Audit Viewer) — den logning overlever uanset browser/iframe og er den mest robuste kilde, hvis I skal dokumentere timeouts systematisk på tværs af flere agenter/maskiner.
- **Direkte og proxy-vejen** har intet centralt spor — kun den lokale `localStorage`-log (én maskine ad gangen) eller evt. AI-udbyderens/Cloudflare Workerens egne logs.
- **OBS — privatliv/delte maskiner**: `localStorage` gemmer kun én session ad gangen (overskrives ved hver ny), men den ligger på tværs af alle samtaler på samme browser/maskine, indtil den overskrives eller ryddes ("Ryd"-knappen i Log-fanen rydder også den gemte kopi). På delte agent-maskiner bør I være opmærksomme på, at forrige agents logline (inkl. transskript-uddrag i loggen) potentielt kan hentes af den næste, der åbner widget'en.

## Kendte begrænsninger
- `transcripturl` kan først levere data et stykke tid efter samtalens afslutning — brug realtid, hvis resuméet skal være klar øjeblikkeligt.
- Realtidstransskripter kommer i batches; med Low Latency ca. 3-5 sek. forsinkelse.
- API-nøgler i browseren er praktisk til pilot/PoC. Til produktion bør AI-kaldet flyttes bag en lille proxy (f.eks. en Genesys Function Data Action eller Cloudflare Worker), så nøglen ikke ligger hos agenterne.

v1.0.0

---

## v1.1.0 — Automatisk realtid + AI-proxy

### Automatisk start (agenten gør intet)
Med "Start realtidstransskription automatisk" slået til (standard):
1. Widget'en åbner med interaktionen (`{{gcConversationId}}` i URL'en).
2. Mangler der token, laves et lydløst SSO-redirect til Genesys-login — agenten er allerede logget ind, så det hopper straks tilbage (loop-beskyttet via sessionStorage-flag).
3. Widget'en abonnerer selv på transskriptionstopic'et og teksten strømmer ind.
4. Ved `SESSION_ENDED` (kunden lagde på) får agenten besked om at resuméet kan genereres.

Krav for helt automatisk login: OAuth-klientens redirect URI skal matche widget-URL'en præcist, og Client ID skal være gemt i widget'en én gang pr. browser (eller tilføj `&clientId=...` kan evt. bygges på senere).

### AI-proxy (`proxy-worker.js`, Cloudflare Worker)
Nøgleprioritering som ønsket: **findes der en server-side nøgle i proxyen, bruges den altid** — nøgler sat i widget'en ignoreres og er kun fallback, hvis proxyen ikke har en nøgle for den valgte udbyder.

```bash
npx wrangler deploy proxy-worker.js --name ai-summary-proxy
npx wrangler secret put OPENAI_API_KEY      # kun de udbydere proxyen skal eje
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
# valgfri hærdning:
npx wrangler secret put ALLOWED_ORIGIN      # fx https://<bruger>.github.io
npx wrangler secret put PROXY_TOKEN
```

Indsæt worker-URL'en i widget'ens felt "Proxy-URL". Endpoint: `POST /summarize` med `{provider, model, prompt, clientKey?}` → `{text, keySource}` hvor `keySource` viser om server- eller klientnøglen blev brugt.

---

## v1.2.0 — Ollama + sammenligning af udbydere

### Ollama (lokal model — gratis, data forlader ikke huset)
Ny udbyder "Ollama (lokal)" med URL (standard `http://localhost:11434`) og modelfelt (`llama3.1`, `qwen2.5`, `mistral` …).

**Direkte fra widget (agentens maskine):**
```
# Windows (PowerShell, permanent):
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS","https://<bruger>.github.io","User")
# genstart Ollama, hent en model:
ollama pull llama3.1
```
Uden `OLLAMA_ORIGINS` blokerer Ollama CORS-kald fra widget-domænet. Browsere tillader HTTPS-side → `http://localhost`, så mixed content er ikke et problem i Chrome/Edge/Firefox.

**Via proxy (fælles Ollama-server):** sæt `OLLAMA_URL` som secret i workeren — den vinder altid over widget'ens URL (samme prioritering som API-nøglerne). Serveren skal kunne nås fra Cloudflare (cloudflared tunnel, Tailscale Funnel eller on-prem reverse proxy) — ikke agentens localhost.

### Sammenlign udbydere ("se forskellen")
Ny knap **Sammenlign udbydere** på Resumé-fanen: kører samme prompt parallelt på alle udbydere, der er konfigureret (nøgle sat, Ollama-URL sat, eller proxy aktiv), og viser resultaterne under hinanden med svartid pr. udbyder — så kvalitet vs. pris vs. hastighed kan vurderes direkte på rigtige samtaler. Enkeltkald viser nu også udbyder + svartid i statuslinjen.

---

## v1.3.0 — Function Data Action + systembeskrivelse

### Function Data Action (anbefalet til produktion)
AI-kaldet kan nu køre som **Function Data Action inde i Genesys Cloud** — nøglerne ligger udelukkende i integrationens Credentials-tab og forlader aldrig Genesys. Widget'en eksekverer action'en med agentens eget token via `POST /api/v2/integrations/actions/{id}/execute` (kræver `integrations:action:execute`).

Prioritering i widget'en: **Data Action > Proxy > Direkte** — sæt Action ID i det nye felt under Opsætning, så bruges den vej altid.

Opsætning:
1. Admin → Integrations → **Genesys Cloud Function** → ny integration.
2. Credentials-tab: felterne `openaiKey`, `geminiKey`, `anthropicKey`, `ollamaUrl` (kun dem der bruges).
3. Upload `function-ai-summary.zip` · Runtime `nodejs20.x` · Handler `src/index.handler` · timeout så højt som muligt.
4. Opret Data Action på integrationen — kontrakter, Request Body Template og translation map ligger klar til copy/paste i `gc-function/CONTRACTS.md`.
5. Publicér, kopiér Action ID ind i widget'en.

### Systembeskrivelse
`SYSTEM.html` — selvstændig, dansk/engelsk med sprogknap, fire SVG-diagrammer: arkitekturoverblik, realtidssekvens, hent-sekvens (ACW) og beslutningsdiagram for AI-vej/nøgleprioritering, plus funktions-, komponent- og kravtabeller. Læg den i samme repo — så er dokumentationen hostet sammen med widget'en.

### v1.3.1 — MCP-afgrænsning i systembeskrivelsen
Nyt afsnit 8 + Fig. 5 i `SYSTEM.html`: forskellen på Genesys' native MCP (Copilot/Virtual Agent som MCP-klient — handlinger UD af platformen, ingen transskript-adgang) og community MCP-servere (wrapper Platform API'et, transcript via samme transcripturl-endpoint — til supervisor/QM-analyse i Claude Desktop/Cowork, ikke til agent-widget'en). Inkl. scenarietabel: widget vs. MCP-server vs. native MCP/Copilot.

### v1.4.2 — Modelnavn i loggen
`AI call`/`AI response`-loglinjerne i Log-fanen viser nu også hvilken model der reelt blev brugt (`modelOpenai`/`modelGemini`/`modelClaude`/`modelOllama` fra Opsætning), ikke kun udbyderen.

### v1.4.3 — Log-persistens i localStorage
Hele loggen spejles nu løbende til `localStorage` (nøgle `gcTranscriptWidgetLog`, overskrives pr. session) og overlever dermed at iframen lukkes uden at agenten når at klikke "Gem log" — fx ved en ACW-timeout, mens AI-resuméet stadig kører. Log-fanen viser automatisk en knap **"Hent forrige log"**, hvis der findes en gemt session fra sidste gang widget'en kørte i samme browser; den downloader den fulde forrige log som tekstfil. "Ryd"-knappen rydder både den aktuelle visning og den gemte kopi. Se afsnittet "Se efterfølgende om AI-resuméet nåede at blive færdigt" ovenfor for brug og begrænsninger (kun seneste session, delt maskine = delt log).
