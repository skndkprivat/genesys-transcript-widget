# check-ollama.ps1 — diagnosticér Ollama-adgang fra widget'en
# Kør:  powershell -ExecutionPolicy Bypass -File check-ollama.ps1
$origin = "https://skndkprivat.github.io"
$base   = "http://localhost:11434"
Write-Host "=== Ollama-tjek for widget-origin $origin ===" -ForegroundColor Cyan

# 1) Kører Ollama?
try {
  $v = Invoke-RestMethod "$base/api/version" -TimeoutSec 3
  Write-Host "[OK]   Ollama koerer, version $($v.version)" -ForegroundColor Green
} catch {
  Write-Host "[FEJL] Ollama svarer ikke paa $base — start Ollama foerst (ollama serve eller app'en)." -ForegroundColor Red
  exit 1
}

# 2) Er OLLAMA_ORIGINS sat (User + Process)?
$u = [Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS","User")
$p = $env:OLLAMA_ORIGINS
Write-Host "OLLAMA_ORIGINS (User)    : $(if ($u) {$u} else {'(ikke sat)'})"
Write-Host "OLLAMA_ORIGINS (Process) : $(if ($p) {$p} else {'(ikke sat)'})"
if (-not $u -and -not $p) {
  Write-Host "[FEJL] OLLAMA_ORIGINS er ikke sat. Koer:" -ForegroundColor Red
  Write-Host "       [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','$origin','User')" -ForegroundColor Yellow
  Write-Host "       og genstart derefter Ollama HELT (luk ogsaa fra systembakken)." -ForegroundColor Yellow
}

# 3) CORS-preflight praecis som browseren laver den
try {
  $r = Invoke-WebRequest -Uri "$base/api/chat" -Method Options -TimeoutSec 5 -Headers @{
    "Origin" = $origin
    "Access-Control-Request-Method"  = "POST"
    "Access-Control-Request-Headers" = "content-type"
  }
  $allow = $r.Headers["Access-Control-Allow-Origin"]
  if ($allow -eq $origin -or $allow -eq "*") {
    Write-Host "[OK]   CORS-preflight godkendt (Access-Control-Allow-Origin: $allow)" -ForegroundColor Green
  } else {
    Write-Host "[FEJL] Preflight svarede, men uden korrekt Allow-Origin (fik: '$allow')." -ForegroundColor Red
    Write-Host "       OLLAMA_ORIGINS er sandsynligvis ikke laest — genstart Ollama helt." -ForegroundColor Yellow
  }
} catch {
  Write-Host "[FEJL] CORS-preflight afvist ($($_.Exception.Message))." -ForegroundColor Red
  Write-Host "       Det er praecis den fejl browseren ser. Saet OLLAMA_ORIGINS og genstart Ollama helt." -ForegroundColor Yellow
}

# 4) Er modellen hentet?
try {
  $tags = Invoke-RestMethod "$base/api/tags" -TimeoutSec 5
  $names = $tags.models | ForEach-Object { $_.name }
  Write-Host "Modeller: $($names -join ', ')"
  if ($names -notmatch "llama3.1") {
    Write-Host "[INFO] llama3.1 er ikke hentet — koer: ollama pull llama3.1 (eller skift model i widget'en)." -ForegroundColor Yellow
  }
} catch { Write-Host "[INFO] Kunne ikke hente modelliste." -ForegroundColor Yellow }

Write-Host "=== Faerdig ===" -ForegroundColor Cyan
