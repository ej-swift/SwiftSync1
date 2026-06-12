!macro customInstall
  ; Ensure desktop shortcut exists and always uses the bundled SwiftSync icon.
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  ; Refresh Start Menu shortcut icon too (covers upgrades from older builds).
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

  ; Bundled relay + OAuth config (Electron userData for package name "swiftsync")
  CreateDirectory "$APPDATA\swiftsync"
  IfFileExists "$APPDATA\swiftsync\relay-config.json" +2 0
    CopyFiles /SILENT "$INSTDIR\resources\relay-config.json" "$APPDATA\swiftsync\relay-config.json"
  IfFileExists "$APPDATA\swiftsync\chat-oauth-apps.json" oauth_done 0
    CopyFiles /SILENT "$INSTDIR\resources\chat-oauth-apps.json" "$APPDATA\swiftsync\chat-oauth-apps.json"
  oauth_done:
  IfFileExists "$APPDATA\swiftsync\chat-oauth-apps.example.json" +2 0
    CopyFiles /SILENT "$INSTDIR\resources\chat-oauth-apps.example.json" "$APPDATA\swiftsync\chat-oauth-apps.example.json"
!macroend
