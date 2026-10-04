; Keep the existing appId/NSIS registry identity and installation directory.
; Both the installer and its uninstaller must wait for an explicit user exit.
; A basename check can conservatively block another installation, but never
; closes or kills that installation (or an in-progress agent task).
!macro VERA_REQUIRE_PROCESS_EXIT EXECUTABLE
  nsProcess::_FindProcess /NOUNLOAD "${EXECUTABLE}"
  Pop $R0
  ${If} $R0 == 0
    nsProcess::_Unload
    MessageBox MB_OK|MB_ICONEXCLAMATION "${EXECUTABLE} is still running. Finish or stop active tasks, then use the tray menu to quit V.E.R.A (or the previous Mr.Robot) before installing or uninstalling." /SD IDOK
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 != 603
    nsProcess::_Unload
    MessageBox MB_OK|MB_ICONSTOP "Could not verify that ${EXECUTABLE} has exited. Installation was stopped without closing any application. Please retry after quitting the app." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro VERA_REQUIRE_PROCESS_EXIT "Mr.Robot.exe"
  !insertmacro VERA_REQUIRE_PROCESS_EXIT "${APP_EXECUTABLE_FILENAME}"
  nsProcess::_Unload
!macroend
