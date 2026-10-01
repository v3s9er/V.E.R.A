param([string]$Destination = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
# Keep the native CMake/Ninja object paths short as well as ASCII-only.
# A GUID directory under the user's long TEMP path can still exceed Windows limits.
if (-not $Destination) { $Destination = Join-Path ([IO.Path]::GetPathRoot($sourceRoot)) ('MrRobotBuildTemp\mrb-' + [guid]::NewGuid().ToString('N').Substring(0, 12)) }
$destinationRoot = [IO.Path]::GetFullPath($Destination)
if ($destinationRoot -match '[^\x00-\x7F]') { throw 'Android build staging requires an ASCII-only directory.' }
if (Test-Path -LiteralPath $destinationRoot) { throw 'Use a new empty staging path; existing files will not be overwritten.' }
$destinationPrefix = $destinationRoot.TrimEnd('\') + '\'
New-Item -ItemType Directory -Path $destinationRoot | Out-Null
# Copy current source, including new implementation files, but never .git,
# ignored runtime data, credentials, dependencies, or old release installers.
$files = @(& git -c core.quotepath=false -C $sourceRoot ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate source files.' }
foreach ($relative in ($files | Sort-Object -Unique)) {
  if ($relative -match '^(release/|release-|\.git/)' -or $relative -match '(^|/)(node_modules|\.stage|\.gradle|build)/') { continue }
  $inputPath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
  $targetPath = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relative))
  if (-not $inputPath.StartsWith($sourceRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $targetPath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped staging boundary.' }
  if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { continue }
  if ((Get-Item -LiteralPath $inputPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Do not copy reparse points into a release staging directory.' }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath $inputPath -Destination $targetPath
}
Write-Output $destinationRoot
