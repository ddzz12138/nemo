# Create a keyless local GBrain home for Nemo.
# Init flags from the pinned gbrain-src init command:
#   --pglite --no-embedding --db-only --search-mode conservative --non-interactive --json
# --force is added only when this script is given -Force.
# An existing brain is refused unless -Force is present. There is no default
# data directory; the operator must pass -DataDir. Writes only under that directory.
[CmdletBinding()]
param(
  [string]$DataDir,
  [switch]$LocalEmbeddings,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Bun = $env:NEMO_GBRAIN_BUN
$Source = $env:NEMO_GBRAIN_SOURCE

function Fail([string]$Message, [int]$Code = 1) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if (-not $DataDir) { Fail 'Pass -DataDir with the directory that should hold this GBrain home.' 2 }
if ($DataDir -match '\.\.') { Fail 'DataDir must not contain parent segments.' 2 }
try { $DataDir = [System.IO.Path]::GetFullPath($DataDir) }
catch { Fail 'DataDir is not a usable path.' 2 }

$GbrainDir = Join-Path $DataDir '.gbrain'
$ConfigPath = Join-Path $GbrainDir 'config.json'
$DatabasePath = Join-Path $GbrainDir 'brain.pglite'
if ((Test-Path -LiteralPath $ConfigPath) -or (Test-Path -LiteralPath $DatabasePath)) {
  if (-not $Force) { Fail 'The destination already has a GBrain database. Pass -Force to replace it.' 1 }
}

if (-not $Bun -or -not $Source) {
  $TemplatePath = Join-Path (Split-Path -Parent $PSScriptRoot) '.nemo\gbrain-engine.json'
  if (Test-Path -LiteralPath $TemplatePath) {
    $Template = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
    if (-not $Bun) { $Bun = $Template.runtimePath }
    if (-not $Source) { $Source = $Template.sourceRoot }
  }
}
if (-not $Bun -or -not (Test-Path -LiteralPath $Bun -PathType Leaf)) { Fail 'Configure the local Bun runtime first.' 2 }
if (-not $Source) { Fail 'Configure the local GBrain source first.' 2 }
$Cli = Join-Path $Source 'src\cli.ts'
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) { Fail 'The local GBrain source is missing.' 2 }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

foreach ($item in @(Get-ChildItem Env:)) {
  if ($item.Name -match 'API_KEY|CLIENT_SECRET|ACCESS_TOKEN|DATABASE_URL') {
    Remove-Item -Path "Env:$($item.Name)" -ErrorAction SilentlyContinue
  }
}
foreach ($name in @('NODE_OPTIONS', 'GBRAIN_DATABASE_URL')) {
  Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
}
$env:GBRAIN_HOME = $DataDir
$env:GBRAIN_SKIP_STARTUP_HOOKS = '1'
$env:GBRAIN_NO_RETRY_CONNECT = '1'
$env:NO_COLOR = '1'
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'

$OutLog = Join-Path $DataDir 'setup-gbrain.out.log'
$ErrLog = Join-Path $DataDir 'setup-gbrain.err.log'

function Invoke-PinnedGbrain([string[]]$GbrainArgs) {
  Remove-Item -LiteralPath $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue
  $argList = @('--no-env-file', $Cli) + $GbrainArgs
  $proc = Start-Process -FilePath $Bun -ArgumentList $argList -WorkingDirectory $Source -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  if ($proc.ExitCode -ne 0) { Fail "gbrain $($GbrainArgs[0]) failed." $proc.ExitCode }
}

function Assert-GbrainValue([string]$Key, [string]$Expected) {
  Invoke-PinnedGbrain @('config', 'get', $Key)
  $raw = [System.IO.File]::ReadAllText($OutLog)
  $first = (($raw -split '\r?\n') | Where-Object { $_ -ne '' } | Select-Object -First 1)
  if ([string]$first.Trim() -ne $Expected) { Fail 'A required GBrain setting was not applied.' }
}

$embeddingArgs = if($LocalEmbeddings){ @('--embedding-model','ollama:nomic-embed-text','--embedding-dimensions','768') }else{ @('--no-embedding') }
Invoke-PinnedGbrain (@('init', '--pglite', '--db-only', '--search-mode', 'conservative', '--non-interactive', '--json') + $embeddingArgs + $(if ($Force) { @('--force') } else { @() }))

foreach ($pair in @(
  @('memory.auto_writeback', 'off'),
  @('facts.extraction_enabled', 'false'),
  @('auto_chronicle', 'false'),
  @('auto_link', 'false'),
  @('loops.extraction_enabled', 'false'),
  @('autopilot.auto_drain.enabled', 'false'),
  @('autopilot.git_pull', 'false'),
  @('autopilot.nightly_quality_probe.enabled', 'false'),
  @('autopilot.conversation_parser_probe.enabled', 'false'),
  @('eval.capture', 'false'),
  @('self_upgrade.mode', 'off')
)) {
  Invoke-PinnedGbrain @('config', 'set', $pair[0], $pair[1])
}

Assert-GbrainValue 'search.mode' 'conservative'
Assert-GbrainValue 'memory.auto_writeback' 'off'
Assert-GbrainValue 'facts.extraction_enabled' 'false'

foreach ($envName in @('.env', 'env')) {
  $envPath = Join-Path $GbrainDir $envName
  if (Test-Path -LiteralPath $envPath) { Remove-Item -LiteralPath $envPath -Force }
}
Remove-Item -LiteralPath $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $ConfigPath)) { Fail 'GBrain did not write a local configuration.' }
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($cfg.engine -ne 'pglite') { Fail 'GBrain engine is not the local database.' }
if($LocalEmbeddings){
  if($cfg.embedding_disabled -eq $true -or $cfg.embedding_model -ne 'ollama:nomic-embed-text' -or $cfg.embedding_dimensions -ne 768){Fail 'GBrain did not configure the required local embedding model.'}
}else{
  if ($cfg.embedding_disabled -ne $true) { Fail 'GBrain embeddings were not left disabled.' }
}
if ($cfg.memory.auto_writeback -ne 'off') { Fail 'GBrain writeback was not turned off.' }
if ($cfg.PSObject.Properties.Name -contains 'database_url' -and $cfg.database_url) { Fail 'GBrain was left with a database URL.' }
if ($cfg.PSObject.Properties.Name -contains 'remote_mcp' -and $null -ne $cfg.remote_mcp) { Fail 'GBrain was left with a remote connection.' }
if ($cfg.self_upgrade.mode -ne 'off') { Fail 'GBrain self-upgrade was not turned off.' }

function Test-SecretName($node, [int]$Depth) {
  if ($null -eq $node -or $Depth -gt 6) { return $false }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($prop in $node.PSObject.Properties) {
      if ($prop.Name -match 'api_key|client_secret|access_token|guardrails_module|provider_base_urls') { return $true }
      if (Test-SecretName $prop.Value ($Depth + 1)) { return $true }
    }
  }
  return $false
}
if (Test-SecretName $cfg 0) { Fail 'GBrain config contains a credential field.' }

$expected = [System.IO.Path]::GetFullPath($DatabasePath)
$actual = [System.IO.Path]::GetFullPath([string]$cfg.database_path)
if ($actual.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { Fail 'GBrain database path does not match DataDir.' }

Write-Output 'GBrain home is ready.'
