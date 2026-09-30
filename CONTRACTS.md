# Data Action konfiguration (kopiér/indsæt)

## Input Contract (JSON)
```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string", "description": "openai | gemini | claude | azure | ollama" },
    "model":    { "type": "string", "description": "Modelnavn; for azure = deployment-navn (tom = azureDeployment-credential)" },
    "prompt":   { "type": "string" }
  },
  "required": ["provider", "prompt"],
  "additionalProperties": false
}
```

## Output Contract (JSON)
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

## Request Body Template
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

## Response / Translation Map
```json
{
  "text":     "$.text",
  "provider": "$.provider",
  "model":    "$.model"
}
```

## Function-konfiguration
- Runtime: `nodejs22.x` (Node.js 20 er end-of-life siden april 2026)
- Handler: `src/index.handler`
- Zip: `function-ai-summary.zip` (indeholder `src/index.js` + `src/package.json`)
- Timeout: sæt så højt som muligt (AI-kald kan tage 5-15 sek.)
- Credentials (integrationens Credentials-tab): `openaiKey`, `geminiKey`, `anthropicKey`, `ollamaUrl`, `ollamaModel` (standard `llama3.1`), `azureKey`, `azureEndpoint` (fx `https://mit-resource.openai.azure.com`), `azureDeployment` (standard-deployment), `azureApiVersion` (valgfri, standard `2024-08-01-preview`) — kun de felter der bruges; resten kan være tomme.

> **Azure-endpoint og API-version** læses kun fra credentials — aldrig fra widget'en — så organisationens Azure-nøgle ikke kan sendes til en host, som kalderen har valgt. Widget'en sender kun `provider`, `model` og `prompt` (input-kontrakten har `additionalProperties: false`).

> **`$esc.jsonString(...)` er nødvendig.** Transskriptionen indeholder altid linjeskift og ofte anførselstegn. Uden escaping bliver den renderede request body ugyldig JSON, og kaldet fejler.

> **`allowedModels`** (credential, kommasepareret, fx `gpt-4o-mini,gpt-4o`) styrer, hvilke modeller/deployments kalderen må vælge. Er feltet tomt, tillades kun standardmodellen pr. udbyder (`gpt-4o-mini`, `gemini-flash-latest`, `claude-sonnet-4-5`, `azureDeployment`, `ollamaModel`). Promptlængden er begrænset til 120.000 tegn.
