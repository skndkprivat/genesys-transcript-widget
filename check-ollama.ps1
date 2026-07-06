# check-ollama.ps1 - diagnosticer Ollama-adgang fra widget'en (ren ASCII)
# Koer:  powershell -ExecutionPolicy Bypass -File check-ollama.ps1
$origin = "https://skndkprivat.github.io"
$base   = "http://localhost:11434"
Write-Host "=== Ollama-tjek for widget-origin $origin ===" -ForegroundColor Cyan

# 1) Koerer Ollama?
try {
  $v = Invoke-RestMethod "$base/api/version" -TimeoutSec 3
  Write-Host "[OK]   Ollama koerer, version $($v.version)" -ForegroundColor Green
} catch {
  Write-Host "[FEJL] Ollama svarer ikke paa $base. Start Ollama foerst (app eller 'ollama serve')." -ForegroundColor Red
  exit 1
}

# 2) Er OLLAMA_ORIGINS sat (User + Process)?
$u = [Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS","User")
$p = $env:OLLAMA_ORIGINS
if ($u) { Write-Host "OLLAMA_ORIGINS (User)    : $u" } else { Write-Host "OLLAMA_ORIGINS (User)    : (ikke sat)" }
if ($p) { Write-Host "OLLAMA_ORIGINS (Process) : $p" } else { Write-Host "OLLAMA_ORIGINS (Process) : (ikke sat)" }
if (-not $u) {
  Write-Host "[FEJL] OLLAMA_ORIGINS er ikke sat paa User-niveau. Koer:" -ForegroundColor Red
  Write-Host "       [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','$origin','User')" -ForegroundColor Yellow
  Write-Host "       og genstart derefter Ollama HELT (luk ogsaa ikonet i systembakken)." -ForegroundColor Yellow
}

# 3) CORS-preflight praecis som browseren laver den
$preflightOk = $false
try {
  $r = Invoke-WebRequest -Uri "$base/api/chat" -Method Options -TimeoutSec 5 -UseBasicParsing -Headers @{
    "Origin" = $origin
    "Access-Control-Request-Method"  = "POST"
    "Access-Control-Request-Headers" = "content-type"
  }
  $allow = $r.Headers["Access-Control-Allow-Origin"]
  if ($allow -eq $origin -or $allow -eq "*") {
    Write-Host "[OK]   CORS-preflight godkendt (Access-Control-Allow-Origin: $allow)" -ForegroundColor Green
    $preflightOk = $true
  } else {
    Write-Host "[FEJL] Preflight svarede uden korrekt Allow-Origin (fik: '$allow')." -ForegroundColor Red
    Write-Host "       Ollama har sandsynligvis ikke laest OLLAMA_ORIGINS. Genstart Ollama helt." -ForegroundColor Yellow
  }
} catch {
  Write-Host "[FEJL] CORS-preflight afvist ($($_.Exception.Message))." -ForegroundColor Red
  Write-Host "       Det er samme fejl som browseren ser. Saet OLLAMA_ORIGINS og genstart Ollama helt." -ForegroundColor Yellow
}

# 4) Er modellen hentet?
try {
  $tags = Invoke-RestMethod "$base/api/tags" -TimeoutSec 5
  $names = @($tags.models | ForEach-Object { $_.name })
  Write-Host ("Modeller: " + ($names -join ", "))
  $found = $false
  foreach ($n in $names) { if ($n -like "llama3.1*") { $found = $true } }
  if (-not $found) {
    Write-Host "[INFO] llama3.1 er ikke hentet. Koer: ollama pull llama3.1 (eller skift model i widget'en)." -ForegroundColor Yellow
  }
} catch {
  Write-Host "[INFO] Kunne ikke hente modelliste." -ForegroundColor Yellow
}

if ($preflightOk) {
  Write-Host "=== ALT OK. Virker widget'en stadig ikke, er browseren selv blokeringen (Private Network Access) - sig til, saa loeser vi det. ===" -ForegroundColor Green
} else {
  Write-Host "=== Ret [FEJL]-punkterne ovenfor og koer scriptet igen. ===" -ForegroundColor Cyan
}
