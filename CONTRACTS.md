# Data Action konfiguration (kopiér/indsæt)

## Input Contract (JSON)
```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string", "description": "openai | gemini | claude | ollama" },
    "model":    { "type": "string" },
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
  "provider":     "${input.provider}",
  "model":        "${input.model}",
  "prompt":       "${input.prompt}",
  "openaiKey":    "${credentials.openaiKey}",
  "geminiKey":    "${credentials.geminiKey}",
  "anthropicKey": "${credentials.anthropicKey}",
  "ollamaUrl":    "${credentials.ollamaUrl}"
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
- Runtime: `nodejs20.x`
- Handler: `src/index.handler`
- Zip: `function-ai-summary.zip` (indeholder `src/index.js` + `src/package.json`)
- Timeout: sæt så højt som muligt (AI-kald kan tage 5-15 sek.)
- Credentials (integrationens Credentials-tab): `openaiKey`, `geminiKey`, `anthropicKey`, `ollamaUrl` — kun de felter der bruges; resten kan være tomme.
