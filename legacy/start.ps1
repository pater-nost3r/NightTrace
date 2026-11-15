$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$python = if (Test-Path -LiteralPath $runtime) { $runtime } else { 'python' }
$dependencies = Join-Path $PSScriptRoot '.deps'
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$dependencies;$env:PYTHONPATH" } else { $dependencies }
& $python -c 'import astropy, numpy, scipy, PIL' 2>$null
if ($LASTEXITCODE -ne 0) {
    & $python -m pip install --target $dependencies --upgrade -r (Join-Path $PSScriptRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Could not install SkyShift dependencies.' }
}
& $python -B (Join-Path $PSScriptRoot 'server.py')
