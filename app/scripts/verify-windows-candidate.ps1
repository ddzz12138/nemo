param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ExpectedThumbprint,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if ($ExpectedThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'An expected trusted publisher certificate thumbprint is required.' }
$nemoFiles = @((Join-Path $AppDirectory 'Nemo.exe'), $Installer)
$nemoEvidence = foreach ($nemoFile in $nemoFiles) {
  $nemoResolved = (Resolve-Path -LiteralPath $nemoFile).Path
  $nemoSignature = Get-AuthenticodeSignature -LiteralPath $nemoResolved
  if ($nemoSignature.Status -ne 'Valid' -or $nemoSignature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint -or -not $nemoSignature.TimeStamperCertificate) {
    throw 'Candidate signature, trusted publisher or timestamp verification failed. No handoff is permitted.'
  }
  [pscustomobject]@{file=[IO.Path]::GetFileName($nemoResolved); bytes=(Get-Item -LiteralPath $nemoResolved).Length; sha256=(Get-FileHash -LiteralPath $nemoResolved -Algorithm SHA256).Hash.ToLowerInvariant(); publisher=$nemoSignature.SignerCertificate.Subject; thumbprint=$nemoSignature.SignerCertificate.Thumbprint; timestamped=$true}
}
$nemoOutput = [IO.Path]::GetFullPath($Output)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($nemoOutput)) | Out-Null
[IO.File]::WriteAllText($nemoOutput, (@{version=1;verified=$true;files=@($nemoEvidence)} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Output 'Final application and installer signatures verified. Clean-PC acceptance is still required.'
