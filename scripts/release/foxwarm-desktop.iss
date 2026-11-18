; Foxwarm Desktop for Windows: a per-user Inno Setup installer for the published Desktop
; directory. scripts/release/package.mjs compiles it from the same publication as
; foxwarm-desktop-win-x64.zip:
;   ISCC.exe /DAppVersion=<version> /DSourceDir=<publication> /O<output> foxwarm-desktop.iss
; Settings, conversations and the WebView2 profile live in %LOCALAPPDATA%\Foxwarm\Desktop\data,
; outside the program directory; neither upgrades nor uninstallation touch them.

#ifndef AppVersion
  #error Define AppVersion, the release version
#endif
#ifndef SourceDir
  #error Define SourceDir, the published Desktop directory
#endif
#define AppExe "Foxwarm.Desktop.exe"
; Identifies the installation for upgrades and uninstallation; never change it.
#define AppGuid "6BE01B0C-EDFF-4777-A5DE-FB2F3BB5167D"

[Setup]
AppId={{{#AppGuid}}
AppName=Foxwarm
AppVersion={#AppVersion}
AppVerName=Foxwarm {#AppVersion}
AppPublisher=Foxwarm Contributors
AppPublisherURL=https://foxwarm.net/
AppSupportURL=https://github.com/550W-HOST/foxwarm/issues
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DefaultDirName={autopf}\Foxwarm
DisableProgramGroupPage=yes
UninstallDisplayName=Foxwarm
UninstallDisplayIcon={app}\{#AppExe}
SetupIconFile={#SourceDir}\Foxwarm.ico
WizardStyle=modern
OutputBaseFilename=foxwarm-desktop-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
SetupMutex=FoxwarmDesktopSetup
; Simplified Chinese for a Chinese Windows display language, English otherwise; /LANG= overrides it.
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
; [Code] stops Foxwarm through its own exit path; the Restart Manager would not.
CloseApplications=no

[Languages]
; English comes first: it is the language when no other matches.
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
english.AutostartTask=Start Foxwarm when I sign in to Windows
english.StillRunning=Foxwarm is still running and could not be closed. Exit Foxwarm from its icon in the notification area, then try again.
english.WebView2Missing=Foxwarm needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer. Install the Evergreen x64 Runtime from Microsoft's WebView2 download page before you start Foxwarm.
english.OpenWebView2Download=Open the WebView2 Runtime download page
chinesesimplified.AutostartTask=登录 Windows 时启动 Foxwarm
chinesesimplified.StillRunning=Foxwarm 仍在运行，无法关闭。请在托盘图标菜单中选择 Exit 退出 Foxwarm，然后重试。
chinesesimplified.WebView2Missing=Foxwarm 需要 Microsoft Edge WebView2 Runtime，但这台电脑上没有安装。启动 Foxwarm 前，请从微软的 WebView2 下载页面安装 Evergreen x64 运行时。
chinesesimplified.OpenWebView2Download=打开 WebView2 Runtime 下载页面

[Tasks]
Name: "autostart"; Description: "{cm:AutostartTask}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Foxwarm"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"

[Registry]
; A sign-in start opens in the notification area.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Foxwarm"; ValueData: """{app}\{#AppExe}"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,Foxwarm}"; Flags: nowait postinstall skipifsilent; Check: WebView2Installed
Filename: "https://developer.microsoft.com/microsoft-edge/webview2/"; Description: "{cm:OpenWebView2Download}"; Flags: shellexec nowait postinstall skipifsilent; Check: not WebView2Installed

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';
  WebView2Client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function RuntimeRegistered(Root: Integer; Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

// Microsoft's documented detection: a per-machine or per-user Evergreen Runtime version.
function WebView2Installed: Boolean;
begin
  Result := RuntimeRegistered(HKLM32, 'SOFTWARE\' + WebView2Client) or RuntimeRegistered(HKCU, 'Software\' + WebView2Client);
end;

// Asks the Foxwarm started from Directory to exit as its Exit menu item does, and waits until no
// process runs its executable. A copy started elsewhere, such as an extracted ZIP, is left alone.
function StopFoxwarm(Directory: String): Boolean;
var
  Executable: String;
  ResultCode: Integer;
begin
  Result := True;
  Executable := AddBackslash(Directory) + '{#AppExe}';
  if (Directory = '') or not FileExists(Executable) then
    exit;
  Log('Asking Foxwarm to exit: ' + Executable);
  // An executable that cannot be started is not running either.
  if not Exec(Executable, '--exit', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('Could not run %s --exit (error %d)', [Executable, ResultCode]))
  else if ResultCode <> 0 then
  begin
    Log(Format('Foxwarm is still running (exit code %d)', [ResultCode]));
    Result := False;
  end;
end;

// Removes the previous version's files, recorded by its uninstaller, so files that a release no
// longer ships do not remain. Data, which the installer never recorded, is untouched.
procedure RemovePreviousVersion;
var
  Command: String;
  ResultCode, Waited: Integer;
begin
  if not RegQueryStringValue(HKCU, UninstallKey, 'UninstallString', Command) or (Command = '') then
    exit;
  Log('Removing the previous version: ' + Command);
  if not Exec('>', Command + ' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    Log(Format('The previous version was not removed (code %d); its files are replaced in place', [ResultCode]));
    exit;
  end;
  // The uninstaller's last step, removing itself and the empty directory, finishes after it exits.
  Waited := 0;
  while FileExists(RemoveQuotes(Command)) and (Waited < 10000) do
  begin
    Sleep(100);
    Waited := Waited + 100;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Previous: String;
begin
  Result := CustomMessage('StillRunning');
  if not StopFoxwarm(ExpandConstant('{app}')) then
    exit;
  // The previous installation is normally {app}; a /DIR parameter can choose another directory.
  if RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Previous) then
    if CompareText(AddBackslash(Previous), AddBackslash(ExpandConstant('{app}'))) <> 0 then
      if not StopFoxwarm(Previous) then
        exit;
  RemovePreviousVersion;
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    // A reinstall without the task removes an earlier sign-in start.
    if not WizardIsTaskSelected('autostart') then
      RegDeleteValue(HKCU, RunKey, 'Foxwarm');
    if not WebView2Installed then
      Log('The Microsoft Edge WebView2 Runtime is not installed');
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not WebView2Installed then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + CustomMessage('WebView2Missing');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // After the confirmation and before anything is removed; Abort ends the uninstallation here.
  if CurUninstallStep = usAppMutexCheck then
    while not StopFoxwarm(ExpandConstant('{app}')) do
      if SuppressibleMsgBox(CustomMessage('StillRunning'), mbError, MB_RETRYCANCEL, IDCANCEL) <> IDRETRY then
        Abort;
end;
