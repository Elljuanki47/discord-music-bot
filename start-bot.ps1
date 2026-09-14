$ErrorActionPreference = 'Stop'

$botFolder = 'D:\Proyectos\discord-music-bot'
$logsFolder = Join-Path $botFolder 'logs'

try {
    New-Item -ItemType Directory -Path $logsFolder -Force | Out-Null

    $startOptions = @{
    FilePath = 'C:\Program Files\nodejs\node.exe'
    ArgumentList = '"D:\Proyectos\discord-music-bot\node_modules\tsx\dist\cli.mjs" "D:\Proyectos\discord-music-bot\src\index.ts"'
    WorkingDirectory = $botFolder
    WindowStyle = 'Hidden'
    RedirectStandardOutput = "$logsFolder\bot.log"
    RedirectStandardError = "$logsFolder\errors.log"
    PassThru = $true
    Wait = $true
    }

$botProcess = Start-Process @startOptions

    exit $botProcess.ExitCode
} catch {
    Write-Error $_ -ErrorAction continue
    exit 1
}