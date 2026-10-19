# dsh-workspace-fee -- installer for DSH profiles (web and/or desktop).
#
# WHAT IT DOES
#   Installs this plugin into one or more DSH profiles as a linked bundle layer,
#   so the host half loads at boot and the browser half (the top status bar) is
#   served by the Web carrier.
#
#   IMPORTANT: restart the harness afterwards. The browser half is loaded at
#   server start, so it will not appear until you restart and refresh the page.
#
# WHICH PROFILE?
#   * `web`     -- booted by the standalone CLI: `dsh web`.
#   * `desktop` -- booted by the DeepSeek Harness desktop application. This is
#     an APPLICATION-OWNED profile: the launcher refuses `--profile desktop`
#     unless it is the desktop runtime's own CLI entry (which this script uses
#     when it finds the desktop installation). Windows: install here if you use
#     the desktop app.
#
# IDEMPOTENT
#   Re-running is safe: if the plugin is already linked it performs a no-op
#   re-install and only verifies the manifest.
#
# SANDBOX NOTE
#   This script writes OUTSIDE the plugin directory, into
#   `<DSH_HOME>/profiles/<profile>`. Under a restricted file sandbox that write
#   is denied (EPERM). If it fails with a permission error, run the printed
#   command yourself in a terminal that has write access.
#
# EXECUTION POLICY NOTE (if .ps1 is blocked by execution policy)
#   If PowerShell refuses to run this file, invoke it with a bypass, e.g.
#       powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-profile.ps1
#
#   NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads a
#   .ps1 without a UTF-8 BOM as ANSI/GBK, which mangles non-ASCII text and can
#   even break the parser. Keep it ASCII.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-profile.ps1
#   powershell ... -File scripts\install-profile.ps1 -WhatIf            # dry run
#   powershell ... -File scripts\install-profile.ps1 -Profile web       # one profile
#   powershell ... -File scripts\install-profile.ps1 -Uninstall         # remove
#   powershell ... -File scripts\install-profile.ps1 -DesktopAppDir "D:\path\to\desktop"

[CmdletBinding()]
param(
  [string[]]$Profile = @('web', 'desktop'),
  [string]$DesktopAppDir,
  [string]$DshExe,
  [switch]$Uninstall,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$PluginName = 'dsh-workspace-fee'
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }

# -- 1. Locate a launcher -----------------------------------------------------
# Prefer the desktop runtime's own CLI entry: only it may manage the reserved
# `desktop` profile. A plain `dsh` on PATH is used for `web` when the desktop
# installation is absent.
$exe = $null
$candidates = New-Object System.Collections.Generic.List[string]
if ($DshExe) { $candidates.Add($DshExe) }
if ($env:DSH_DESKTOP_EXE) { $candidates.Add($env:DSH_DESKTOP_EXE) }
if ($DesktopAppDir) { $candidates.Add((Join-Path $DesktopAppDir 'DeepSeek Harness.exe')) }
if ($env:DSH_DESKTOP_APP) { $candidates.Add((Join-Path $env:DSH_DESKTOP_APP 'DeepSeek Harness.exe')) }
if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\@deepseek-aidsh-desktop\DeepSeek Harness.exe')) }
if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')) }
foreach ($cand in $candidates) {
  if ($cand -and (Test-Path $cand)) { $exe = $cand; break }
}
if (-not $exe -and $env:LOCALAPPDATA -and (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs'))) {
  $found = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'DeepSeek Harness.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $exe = $found.FullName }
}

# The desktop CLI entry lives INSIDE app.asar, which PowerShell cannot stat.
# Prefer the shipped .cmd shim (a real file on disk); otherwise build the
# exe + asar-entry invocation without probing the archive.
$desktopCmd = $null
$desktopCli = $null
if ($exe) {
  $appRoot = Split-Path -Parent $exe
  $shim = Join-Path $appRoot 'resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path $shim) { $desktopCmd = $shim }
  $desktopCli = Join-Path $appRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
}
$hasDesktop = [bool]$desktopCmd -or [bool]$exe

$dshOnPath = $null
$onPath = Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue
if (-not $onPath) { $onPath = Get-Command 'dsh' -ErrorAction SilentlyContinue }
if ($onPath) { $dshOnPath = $onPath.Source }

Say "=== $PluginName installer ==="
Say "  plugin dir  : $RepoRoot"
Say "  DSH home    : $DshHome"
Say "  profiles    : $($Profile -join ', ')"
if ($hasDesktop) {
  Ok "desktop launcher: $(if ($desktopCmd) { $desktopCmd } else { $exe })"
} else {
  Warn "desktop installation not found -- the 'desktop' profile cannot be managed"
  Warn "pass -DesktopAppDir <dir containing 'DeepSeek Harness.exe'> to enable it"
}
if ($dshOnPath) { Ok "dsh on PATH: $dshOnPath" } else { Warn "dsh is not on PATH (fine if you only need the desktop profile)" }

function Invoke-ProfilePnpm([string]$profileName, [string[]]$pnpmArgs) {
  # Native child output must not enter this function's return value, and a
  # native stderr line must not abort the run under ErrorActionPreference=Stop
  # (pnpm prints its update notice on stderr). Out-Host shows the output and
  # keeps the function's return value to just the exit code.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($desktopCmd) {
      & $desktopCmd plugin --profile $profileName @pnpmArgs 2>&1 | Out-Host
      return $LASTEXITCODE
    }
    if ($exe -and $desktopCli) {
      $env:ELECTRON_RUN_AS_NODE = '1'
      & $exe --expose-internals $desktopCli plugin --profile $profileName @pnpmArgs 2>&1 | Out-Host
      return $LASTEXITCODE
    }
    if ($dshOnPath) {
      & $dshOnPath plugin --profile $profileName @pnpmArgs 2>&1 | Out-Host
      return $LASTEXITCODE
    }
    return 127
  } finally {
    $ErrorActionPreference = $previous
  }
}

$exit = 0
foreach ($p in $Profile) {
  Say ""
  Say "########## profile: $p ##########"
  $profileDir = Join-Path $DshHome "profiles\$p"
  $profilePkg = Join-Path $profileDir 'package.json'

  if (-not (Test-Path $profilePkg)) {
    Bad "profile not found: $profilePkg"
    if ($p -eq 'desktop') {
      Say "     The desktop profile is created by the DeepSeek Harness application;"
      Say "     start it once, then re-run this script."
    } else {
      Say "     Initialize it once (dsh $p --dump-config), then re-run this script."
    }
    $exit = 1
    continue
  }

  $pkg = Get-Content $profilePkg -Raw -Encoding utf8 | ConvertFrom-Json
  $bundles = @($pkg.dsh.profile.bundles)
  $deps = @($pkg.dependencies.PSObject.Properties.Name)
  $alreadyLinked = ($deps -contains $PluginName) -or ($bundles -contains $PluginName)

  Say "  profile dir : $profileDir"
  Say "  current bundle layers ($($bundles.Count)):"
  $bundles | ForEach-Object { Say "      - $_" }

  $action = if ($Uninstall) { 'remove' } elseif ($alreadyLinked) { 'reinstall' } else { 'add' }
  if ($action -eq 'remove') {
    $pnpmArgs = @('remove', $PluginName)
    $verb = "uninstall $PluginName"
  } else {
    $pnpmArgs = @('add', "link:$RepoRoot")
    $verb = if ($action -eq 'reinstall') { "re-link $PluginName (idempotent)" } else { "install $PluginName" }
  }

  if (-not $hasDesktop -and -not $dshOnPath) {
    Bad "no launcher available for profile '$p'"
    $exit = 1
    continue
  }
  if ($p -eq 'desktop' -and -not $hasDesktop) {
    Bad "the 'desktop' profile can only be managed by the desktop runtime's own CLI"
    $exit = 1
    continue
  }

  Say ""
  Say "  will $verb"
  if ($action -eq 'reinstall') { Warn "  plugin already present; re-install is a no-op for the bundle list" }

  if ($WhatIf) {
    Ok "  -WhatIf: nothing was written for '$p'"
    continue
  }

  Say "  running (writes to $profileDir; a sandbox may deny it)..."
  $code = 1
  try {
    $code = Invoke-ProfilePnpm $p $pnpmArgs
  } catch {
    Warn "  invocation threw: $($_.Exception.Message)"
  }

  if ($code -ne 0) {
    Bad "  dsh plugin exited with code $code"
    Say ""
    Say "  likely causes and what to do:"
    Say "    * Permission denied (EPERM/EACCES): expected inside a restricted sandbox."
    Say "      Run this in a terminal that has write access to $profileDir."
    Say "    * pnpm missing: DSH manages profile dependencies with pnpm."
    Say "    * Network failure: this plugin has zero runtime dependencies, so no"
    Say "      registry access should be needed."
    $exit = $code
    continue
  }
  Ok "  dsh plugin finished (exit 0)"

  $after = Get-Content $profilePkg -Raw -Encoding utf8 | ConvertFrom-Json
  $afterBundles = @($after.dsh.profile.bundles)
  $afterDeps = @($after.dependencies.PSObject.Properties.Name)

  if ($Uninstall) {
    if ($afterDeps -notcontains $PluginName -and $afterBundles -notcontains $PluginName) {
      Ok "  removed from '$p'"
    } else {
      Warn "  still visible in '$p' (deps=$($afterDeps -contains $PluginName) bundles=$($afterBundles -contains $PluginName))"
    }
    continue
  }

  $depOk = $afterDeps -contains $PluginName
  $bundleOk = $afterBundles -contains $PluginName
  if ($depOk) { Ok "  registered in dependencies" } else { Bad "  NOT registered in dependencies" }
  if ($bundleOk) {
    Ok "  registered in dsh.profile.bundles (loads as a bundle layer)"
  } else {
    Warn "  NOT in dsh.profile.bundles -- installed but will NOT load as a layer;"
    Warn "  check that package.json declares dsh.bundle.patch"
  }
  if (-not ($depOk -and $bundleOk)) { if ($exit -eq 0) { $exit = 2 } }
}

Say ""
Say "=== NEXT STEP (required, otherwise you will not see the plugin) ==="
Say ""
Say "  1) Restart the harness that boots the profile you installed into:"
Say "     * desktop: quit and reopen the DeepSeek Harness desktop application."
Say "     * web    : stop `dsh web` and start it again."
Say "     The browser half is loaded at startup, so nothing appears before that."
Say ""
Say "  2) Reload the page. The session header's right side should show a status"
Say "     pill: workspace name + today's spend (CNY) + an alert colour dot."
Say "     Clicking it opens the panel (N-day total, per-workspace bars, and the"
Say "     collapsed sections Daily bill / Token detail / Alert lines / Pricing)."
Say ""
Say "  3) Offline check without a browser (prints the engine's own accounting):"
Say "       node scripts/report.mjs --json"
Say ""
if ($exit -eq 0) { Ok "installer finished." } else { Bad "installer finished with errors (exit $exit)." }
exit $exit
