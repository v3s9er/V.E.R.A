param([int]$ParentPid = 0, [string]$StatePath = '', [switch]$Probe)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot 'LidDisplay.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Runtime.Serialization,System.Xml
if ($Probe) { [MrRobot.LidDisplay.Program]::Probe(); exit 0 }
if ($ParentPid -le 0 -or -not [System.IO.Path]::IsPathRooted($StatePath)) { throw 'Invalid helper configuration' }
[MrRobot.LidDisplay.Program]::Run($ParentPid, $StatePath)
