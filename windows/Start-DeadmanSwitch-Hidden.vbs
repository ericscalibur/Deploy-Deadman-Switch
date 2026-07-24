' Launches Start-DeadmanSwitch.bat with no visible console window.
' Point Task Scheduler at THIS file (via wscript.exe) rather than the .bat
' directly — that is what hides the window and avoids Task Scheduler quirks.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\Start-DeadmanSwitch.bat"
' 0 = hidden window, False = don't wait for it to exit
shell.Run """" & batPath & """", 0, False
