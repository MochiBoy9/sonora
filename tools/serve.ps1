<#
  serve.ps1 - a static server for machines with neither Python nor Node.

  Sonora needs a real origin: ES modules and web workers do not load over
  file://, so opening index.html directly gets you the intro and nothing else.
  The other commands in the README assume a runtime this machine may not have,
  and Windows already ships one - HttpListener is in the .NET base library.

      powershell -ExecutionPolicy Bypass -File tools/serve.ps1
      powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8000

  Ctrl-C stops it. Nothing is installed and nothing is written.

  Kept to plain ASCII on purpose: Windows PowerShell 5.1 reads a .ps1 as the
  system ANSI codepage unless the file carries a UTF-8 BOM, so one stray dash
  in a string is a parse error on somebody else's machine.
#>
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 8123
)

$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath($Root)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Error "Could not listen on port $Port. Is something already using it?"
  exit 1
}

Write-Host "Sonora is serving $Root at http://localhost:$Port/  (Ctrl-C to stop)"

# Only the types this repository actually contains, plus the audio containers
# a test library might be served from. Anything else is handed over as bytes,
# which is what a browser does with an unknown type anyway.
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.webmanifest' = 'application/manifest+json'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/plain; charset=utf-8'
  '.mp3'  = 'audio/mpeg'
  '.m4a'  = 'audio/mp4'
  '.flac' = 'audio/flac'
  '.ogg'  = 'audio/ogg'
  '.opus' = 'audio/ogg'
  '.wav'  = 'audio/wav'
  '.aiff' = 'audio/aiff'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }

    $full = [System.IO.Path]::GetFullPath((Join-Path $Root ($rel -replace '/', '\')))
    # A path that climbs out of the repository is a request for something that
    # was never offered.
    if (-not $full.StartsWith($Root)) { $res.StatusCode = 403; $res.Close(); continue }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
      else { $res.ContentType = 'application/octet-stream' }
      # No caching: this is a development server, and a stale module is an
      # hour spent debugging a bug that was already fixed.
      #
      # The service worker script is the one exception, and it is not
      # cosmetic: Chromium refuses to register a worker whose script it is
      # forbidden to store, and reports it as "an unknown error occurred when
      # fetching the script" - which points at the script, where there is
      # nothing wrong. no-cache still revalidates on every load, so a changed
      # sw.js is still picked up immediately; it only drops the part that says
      # the browser may not keep a copy at all.
      if ($rel -eq 'sw.js') { $res.Headers.Add('Cache-Control', 'no-cache') }
      else { $res.Headers.Add('Cache-Control', 'no-store') }
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.Close()
  } catch {
    # A browser that hangs up mid-response is normal; it is not worth a line.
  }
}
