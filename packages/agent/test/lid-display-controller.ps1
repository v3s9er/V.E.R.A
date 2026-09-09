$ErrorActionPreference = 'Stop'
$lidSource = Join-Path $PSScriptRoot '../../../integrations/lid-display/LidDisplay.cs'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path $lidSource,(Join-Path $PSScriptRoot 'lid-display-controller.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Runtime.Serialization,System.Xml
[LidTests]::Run()
