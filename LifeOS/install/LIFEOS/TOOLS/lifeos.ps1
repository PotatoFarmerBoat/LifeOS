# lifeos launcher shim for PowerShell (windows-port W9).
# Wire it as a function in $PROFILE for the alias experience:
#   function lifeos { & "$env:USERPROFILE\.claude\LIFEOS\TOOLS\lifeos.ps1" @args }
bun "$PSScriptRoot\lifeos.ts" @args
exit $LASTEXITCODE
