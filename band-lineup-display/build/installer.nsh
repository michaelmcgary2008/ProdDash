; Make upgrades self-healing:
; 1. Kill any running Band Lineup process tree.
; 2. Delete the previous install folder directly.
; 3. Remove stale registry keys so electron-builder does not invoke the old uninstaller.

!macro forceCloseBandLineup
  DetailPrint "Force-closing ${PRODUCT_NAME}..."
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R9
  Sleep 500
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -Command "Stop-Process -Name '${PRODUCT_NAME}' -Force -ErrorAction SilentlyContinue"`
  Pop $R9
  Sleep 500
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R9
  Sleep 1000
!macroend

!macro removePreviousInstall ROOT_KEY
  ReadRegStr $R8 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $R8 != ""
    DetailPrint "Removing previous installation from $R8"
    !insertmacro forceCloseBandLineup
    RMDir /r "$R8"
    nsExec::Exec `"$SYSDIR\cmd.exe" /c rmdir /S /Q "$R8"`
    Pop $R9
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -Command "if (Test-Path -LiteralPath '$R8') { Remove-Item -LiteralPath '$R8' -Force -Recurse -ErrorAction SilentlyContinue }"`
    Pop $R9
  ${endif}
  DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}"
!macroend

!macro customCheckAppRunning
  !insertmacro forceCloseBandLineup
!macroend

!macro preInit
  !insertmacro forceCloseBandLineup
!macroend

!macro customInit
  !insertmacro forceCloseBandLineup
  !insertmacro removePreviousInstall HKCU
  !insertmacro removePreviousInstall HKLM
  Sleep 1000
!macroend

!macro customUnInstallCheck
  DetailPrint "Skipping old uninstaller result and continuing with clean install."
  ClearErrors
  StrCpy $R0 0
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "Skipping old per-user uninstaller result and continuing with clean install."
  ClearErrors
  StrCpy $R0 0
!macroend

; ---------------------------------------------------------------------------
; Studio displays: allow the app through Windows Defender Firewall.
;
; Why this belongs in the installer: the firewall prompt fires the moment the app
; starts listening, and Microsoft documents that if the user is NOT a local admin,
; block rules are created no matter which button they press — and a block rule is
; sticky and silent afterwards. The backstage machine then serves localhost perfectly
; while every studio screen times out. The installer is the one place we reliably
; have elevation, so create the allow rules here.
;
; Rules are program-scoped (not port-scoped) so they survive the operator changing
; the display port in the app. UDP covers mDNS on 5353, which publishes the
; nownext.local name that makes bookmarks survive a DHCP change.
;
; NOTE: this needs an elevated (per-machine) install. With oneClick:false and
; perMachine unset, the user may choose a per-user install, where netsh will fail —
; harmlessly, thanks to the swallowed exit codes below. If studio screens can't
; connect, the in-app "Studio Displays" status says so and names the fix.
; ---------------------------------------------------------------------------

!macro addBandLineupFirewallRules
  DetailPrint "Allowing ${PRODUCT_NAME} through Windows Firewall..."
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Band Lineup Display (TCP)"`
  Pop $R9
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Band Lineup Display (UDP)"`
  Pop $R9
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Band Lineup Display (TCP)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=domain,private protocol=TCP`
  Pop $R9
  ; UDP is port-locked deliberately: mDNS is always 5353 (a hard-coded constant in mdns.js),
  ; so unlike the TCP rule this can never go stale, and a program-wide UDP allow would open
  ; every UDP port the app ever binds.
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Band Lineup Display (UDP)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=domain,private protocol=UDP localport=5353`
  Pop $R9
!macroend

!macro removeBandLineupFirewallRules
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Band Lineup Display (TCP)"`
  Pop $R9
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Band Lineup Display (UDP)"`
  Pop $R9
!macroend

!macro customInstall
  !insertmacro addBandLineupFirewallRules
!macroend

!macro customUnInstall
  !insertmacro removeBandLineupFirewallRules
!macroend
