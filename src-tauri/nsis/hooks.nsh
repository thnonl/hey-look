; Hooks of the Windows installer (NSIS) of Hey Look! (WP14, W14.4): the installer behaves like a well-kept program of the system. Tauri's template calls these macros
; at the places named in their names (bundle.windows.nsis.installerHooks in tauri.conf.json). They run in the user's context (per-user install).
;
;   a. A silent install ("/S": an administrator's script, a package manager) puts no shortcut on the desktop that was not there before. The template makes one for
;      silent and passive installs because the finish page, which asks, is skipped; a passive install (the updater's) and the interactive one behave as the template does.
;   b. An uninstall with "Delete the application data" ticked also removes the passwords and tokens the app saved in Windows Credential Manager (the app itself
;      does it: hey-look.exe --remove-saved-credentials, src/credwipe.rs, only the entries of the service "heylook"). Without the tick they stay, like the data.
;   c. An uninstall (not an update) removes the registry key the installer wrote (HKCU\Software\thnonl\Hey Look!) and its parent when it is empty, whatever the tick:
;      what is left of an uninstall is the person's data and nothing else.

Var HeyLookHadDesktopLink

!macro NSIS_HOOK_PREINSTALL
  ; (is there a desktop shortcut already? the one of an earlier install, or one the person made)
  StrCpy $HeyLookHadDesktopLink 0
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    StrCpy $HeyLookHadDesktopLink 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $HeyLookHadDesktopLink = 0
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; before the program file is deleted; the app only talks to the credential store and ends (no window, no single-instance lock)
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --remove-saved-credentials' $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend
