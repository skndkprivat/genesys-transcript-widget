# Function Data Action — opsætningsguide

Guiden sætter AI-resuméet op som en **Genesys Cloud Function Data Action**. Det er den anbefalede vej i produktion: API-nøglerne ligger kun i integrationens Credentials-tab og forlader aldrig Genesys. Widget'en kalder action'en med agentens eget Genesys-token.

**Tidsforbrug:** ca. 20-30 minutter. **Krav:** admin-adgang til Genesys Cloud, en API-nøgle til mindst én AI-udbyder (eller en Ollama-server, der kan nås fra internettet) og filen `function-ai-summary.zip` fra dette repo.

Alt, du skal kopiere ind, står under [Konfiguration til kopiering](#konfiguration-til-kopiering) nederst.

---

## Trin 1 — Opret Function-integrationen
1. **Admin → Integrations → Integrations → + Integrations**.
2. Søg efter **Function Data Actions**, og klik **Install**.
3. Giv den et navn, fx `AI Summary Function`.
4. **Gem**, men lad den være **inaktiv** indtil trin 2 er gjort.

## Trin 2 — Læg nøglerne i Credentials
1. Åbn integrationen → fanen **Configuration → Credentials → Configure**.
2. Vælg credential-typen **User Defined**, og tilføj ét felt pr. værdi. Brug præcis disse feltnavne; du skal kun udfylde dem, du bruger:

| Felt | Indhold | Eksempel |
|---|---|---|
| `openaiKey` | OpenAI API-nøgle | `sk-...` |
| `geminiKey` | Google Gemini API-nøgle (ikke gratis-niveauet til rigtige samtaler) | `AIza...` |
| `anthropicKey` | Anthropic API-nøgle | `sk-ant-...` |
| `azureKey` | Azure OpenAI API-nøgle | |
| `azureEndpoint` | Azure OpenAI-ressourcens endpoint | `https://mit-resource.openai.azure.com` |
| `azureDeployment` | Standard-deployment | `gpt-4o` |
| `azureApiVersion` | Valgfri; standard `2024-08-01-preview` | |
| `ollamaUrl` | Ollama-server, der kan nås fra Genesys Cloud (offentlig/tunneleret URL, **ikke** localhost) | `https://ollama.firma.dk` |
| `ollamaModel` | Valgfri; standard `llama3.1` | |
| `allowedModels` | Valgfri; kommasepareret liste over ekstra modeller/deployments, som widget'en må vælge. Tom = kun standardmodellen pr. udbyder | `gpt-4o-mini,gpt-4o` |

3. **OK → Save**.

> Azure-endpoint og API-version læses **kun** fra credentials og aldrig fra widget'en. Organisationens Azure-nøgle kan derfor ikke sendes til en host, som kalderen har valgt.

## Trin 3 — Aktivér integrationen
Sæt integrationen til **Active** på integrationslisten.

## Trin 4 — Opret Data Action'en
1. **Admin → Integrations → Actions → + Add Action**.
2. Vælg integrationen fra trin 1, og giv action'en et navn, fx `AI Summary`. Klik **Add**.
3. Fanen **Setup → Contracts**:
   - **Input Contract:** skift til JSON-editoren, og indsæt [Input Contract](#input-contract).
   - **Output Contract:** indsæt [Output Contract](#output-contract).
4. Fanen **Setup → Configuration**:
   - **Request → Request Body Template:** indsæt [Request Body Template](#request-body-template).
   - **Response:** indsæt [Response-konfiguration](#response-konfiguration).
   - **Function:** upload `function-ai-summary.zip`, og sæt:
     - Handler: `src/index.handler`
     - Runtime: `nodejs22.x` (Node.js 20 er end-of-life siden april 2026)
     - Timeout: så højt som Genesys tillader. AI-kald tager typisk 5-15 sekunder.
5. **Gem som draft**, men publicér ikke endnu.

## Trin 5 — Test action'en
1. Fanen **Test**. Udfyld input:
   - `provider`: fx `openai` (en udbyder, du har lagt en nøgle ind for)
   - `model`: **tom**, så bruges standardmodellen
   - `prompt`: en tekst med linjeskift og anførselstegn, fx:
     ```
     Opsummér: "Kunden ringede om en faktura."
     Agenten lovede at sende en kreditnota.
     ```
2. Klik **Run Action**. Forventet resultat: `text` indeholder et resumé, `provider` er `openai`, og `model` er `gpt-4o-mini`.
3. Test evt. at model-listen virker: sæt `model` til `gpt-4o`. Uden `gpt-4o` i `allowedModels` skal kaldet fejle med *"Model 'gpt-4o' is not allowed"*.

Linjeskiftene og anførselstegnene i testprompten viser, at `$esc.jsonString` virker. Fejler netop denne test med ugyldig JSON, mangler escapingen i Request Body Template'en.

## Trin 6 — Publicér og find Action ID
1. Klik **Publish**.
2. Find Action ID'et. Det har formen `custom_-_<uuid>` og står i adressefeltet, når action'en er åben i Admin. Du kan også slå det op via `GET /api/v2/integrations/actions?name=AI%20Summary`.

## Trin 7 — Giv agenterne adgang
1. **Admin → People & Permissions → Roles**: giv agent-rollen permissionen `integrations:action:execute`.
2. **Admin → Integrations → OAuth**: widget'ens OAuth-klient (Code Authorization/PKCE) skal have scopet `integrations` ud over `conversations`, `speech-and-text-analytics` og `notifications`.

## Trin 8 — Peg widget'en på action'en
**Admin → Integrations → (widget-integrationen) → Configuration → Application URL**. Tilføj Action ID'et, og lås org-vejen:
```
https://<host>/index.html?conversationId={{gcConversationId}}&langTag={{gcLangTag}}&orgActionId=custom_-_<uuid>&orgLock=1&cfgVersion=1
```
- `orgLock=1` betyder, at agenterne ikke kan bruge egne nøgler eller andre AI-veje.
- `cfgVersion` er et heltal. Hæv det, når agenternes lokale indstillinger skal nulstilles.
- Tilføj evt. `&orgFocus=<URL-encoded tekst>` for fælles fokuspunkter.
- Sæt **aldrig** en API-nøgle i URL'en. Den er synlig for alle agenter.

## Trin 9 — Bekræft i widget'en
1. Åbn en interaktion. Under **Opsætning** skal der stå *"Org-standard aktiv: Data Action … Org-lås aktiv"*.
2. Generér et resumé, og åbn fanen **Log**. Den skal vise `AI call: <udbyder> via data-action, model <navn>` efterfulgt af `AI response: …`.
3. Genesys logger selv hver eksekvering. Brug det til at følge op på fejl og timeouts på tværs af agenter.

---

## Fejlsøgning

| Symptom | Årsag / løsning |
|---|---|
| Ugyldig JSON / request body kan ikke parses | Request Body Template'en mangler `$esc.jsonString(...)` omkring `input.*`-felterne. |
| `No openaiKey credential configured` (eller tilsvarende for andre udbydere) | Feltet mangler i Credentials, eller feltnavnet er stavet forkert (der skelnes mellem store og små bogstaver). |
| `Model '…' is not allowed` | Modellen er hverken standardmodellen eller med i `allowedModels`. Tilføj den, eller ryd modelfeltet i widget'en. |
| `Unknown provider` | Widget'en har sendt en udbyder, funktionen ikke kender. Tjek, at den nyeste zip-fil er uploadet. |
| `No azureEndpoint credential configured` / `Missing or invalid Azure deployment` | Udfyld `azureEndpoint` og `azureDeployment` i Credentials. |
| `Prompt too large` | Transskriptionen er over 120.000 tegn (usædvanligt langt opkald). |
| `Genesys 403` i widget'ens Log | Agenten mangler `integrations:action:execute`, eller OAuth-klienten mangler scopet `integrations`. |
| `Genesys 400` med kontrakt-fejl | Input Contract'en er ikke opdateret. Widget'en sender kun `provider`, `model` og `prompt`, og kontrakten har `additionalProperties: false`. |
| Timeout | Hæv funktionens timeout, eller vælg en hurtigere model (fx en "mini"/"flash"-model). |

---

## Konfiguration til kopiering

### Input Contract
```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string", "description": "openai | gemini | claude | azure | ollama" },
    "model":    { "type": "string", "description": "Modelnavn; for azure = deployment-navn (tom = standardmodel/azureDeployment-credential)" },
    "prompt":   { "type": "string" }
  },
  "required": ["provider", "prompt"],
  "additionalProperties": false
}
```

### Output Contract
```json
{
  "type": "object",
  "properties": {
    "text":     { "type": "string" },
    "provider": { "type": "string" },
    "model":    { "type": "string" }
  },
  "additionalProperties": true
}
```

### Request Body Template
`$esc.jsonString(...)` er nødvendig. Transskriptionen indeholder altid linjeskift og ofte anførselstegn, og uden escaping bliver body'en ugyldig JSON.
```json
{
  "provider":     "$esc.jsonString(${input.provider})",
  "model":        "$esc.jsonString(${input.model})",
  "prompt":       "$esc.jsonString(${input.prompt})",
  "openaiKey":    "${credentials.openaiKey}",
  "geminiKey":    "${credentials.geminiKey}",
  "anthropicKey": "${credentials.anthropicKey}",
  "ollamaUrl":    "${credentials.ollamaUrl}",
  "ollamaModel":  "${credentials.ollamaModel}",
  "azureKey":        "${credentials.azureKey}",
  "azureEndpoint":   "${credentials.azureEndpoint}",
  "azureDeployment": "${credentials.azureDeployment}",
  "azureApiVersion": "${credentials.azureApiVersion}",
  "allowedModels":   "${credentials.allowedModels}"
}
```

### Response-konfiguration
Standardværdierne sikrer, at action'en ikke fejler, hvis et felt mangler i svaret.
```json
{
  "translationMap": {
    "text":     "$.text",
    "provider": "$.provider",
    "model":    "$.model"
  },
  "translationMapDefaults": {
    "text":     "\"\"",
    "provider": "\"\"",
    "model":    "\"\""
  },
  "successTemplate": "{\"text\": ${text}, \"provider\": ${provider}, \"model\": ${model}}"
}
```

### Function-indstillinger
- Handler: `src/index.handler`
- Runtime: `nodejs22.x`
- Zip: `function-ai-summary.zip` (indeholder `src/index.js` + `src/package.json`)
- Timeout: så højt som Genesys tillader

### Standardmodeller
Er `model` tom, eller er `allowedModels` ikke sat, bruges disse modeller:

| Udbyder | Standardmodel |
|---|---|
| `openai` | `gpt-4o-mini` |
| `gemini` | `gemini-flash-latest` |
| `claude` | `claude-sonnet-4-5` |
| `azure` | credential `azureDeployment` |
| `ollama` | credential `ollamaModel`, ellers `llama3.1` |

Promptlængden er begrænset til 120.000 tegn, og svaret til ca. 1.000 tokens.
