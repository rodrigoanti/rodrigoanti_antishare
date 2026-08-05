!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AntiShare inbound TCP 8765"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AntiShare inbound UDP 8766"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AntiShare inbound TCP 8765" dir=in action=allow program="$INSTDIR\AntiShare.exe" enable=yes profile=any protocol=TCP localport=8765'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AntiShare inbound UDP 8766" dir=in action=allow program="$INSTDIR\AntiShare.exe" enable=yes profile=any protocol=UDP localport=8766'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AntiShare inbound TCP 8765"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AntiShare inbound UDP 8766"'
!macroend
