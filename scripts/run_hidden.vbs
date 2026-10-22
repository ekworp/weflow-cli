' Silent launcher for the WeFlow daily task.
'
' Why this file exists: a scheduled action that runs "powershell.exe -File ..." starts a
' CONSOLE program, so Windows creates a console window before PowerShell can hide it - you
' see a black box appear, and it is especially intrusive over a full-screen game. wscript.exe
' is a GUI process with no console at all, and WshShell.Run with window style 0 keeps the
' child hidden too.
'
' Arguments are forwarded verbatim, so "run_hidden.vbs noon" is the noon pass.
'
' ASCII only on purpose: Windows Script Host reads this file with the ANSI code page.

Dim fso, here, script, cmd, sh
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "daily_task.ps1")

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
If WScript.Arguments.Count > 0 Then
    cmd = cmd & " " & WScript.Arguments(0)
End If

Set sh = CreateObject("WScript.Shell")
' 0 = hidden window, True = wait for the child so the task's last result reflects the run.
sh.Run cmd, 0, True
