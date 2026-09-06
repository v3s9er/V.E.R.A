param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
function Await-OcrOperation($Operation, $ResultType) {
    $task = $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(20000)) { throw 'OCR timed out' }
    return $task.Result
}
$file = Await-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-OcrOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
    $decoder = Await-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-OcrOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $engine) { throw 'Windows OCR language is unavailable' }
        $result = Await-OcrOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        @($result.Lines | ForEach-Object { $_.Text }) -join "`n"
    } finally { $bitmap.Dispose() }
} finally { $stream.Dispose() }
