# Run on the exact portable directory produced by npm run package:win.
# Missing/disabled Defender is recorded as unverified, never as a passing scan.
$ErrorActionPreference = 'Stop'
$package = Resolve-Path 'release/AmbientCompanion-win32-x64'
$report = [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    platform = [Environment]::OSVersion.VersionString
    commit = $env:GITHUB_SHA
    files = @()
    defender = [ordered]@{ status = 'unverified'; reason = '' }
    interactiveWindowsAudioAndTaskbar = 'unverified: requires an interactive Windows 10/11 desktop and actual cloud configuration'
}
foreach ($name in @('VoiceAssistant.exe', 'resources/app.asar')) {
    $file = Join-Path $package $name
    $report.files += @{ path = $name; sha256 = (Get-FileHash -Algorithm SHA256 $file).Hash }
}
$scannerExit = $null
try {
    $status = Get-MpComputerStatus
    if (-not $status.AntivirusEnabled) { throw 'Microsoft Defender Antivirus is not enabled' }
    $scanner = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform/*/MpCmdRun.exe" |
        Sort-Object DirectoryName -Descending | Select-Object -First 1
    if (-not $scanner) { throw 'MpCmdRun.exe is unavailable' }
    $report.defender.signatureVersion = $status.AntivirusSignatureVersion
    $report.defender.signatureUpdated = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o')
    & $scanner.FullName -Scan -ScanType 3 -File $package -DisableRemediation
    $scannerExit = $LASTEXITCODE
    $report.defender.exitCode = $scannerExit
    $report.defender.status = if ($scannerExit -eq 0) { 'passed' } else { 'failed' }
} catch {
    $report.defender.reason = $_.Exception.Message
}
$report | ConvertTo-Json -Depth 8 | Set-Content 'release/windows-verification.json' -Encoding utf8
if ($null -ne $scannerExit -and $scannerExit -ne 0) { throw "Defender scan did not pass (exit $scannerExit). See windows-verification.json." }
