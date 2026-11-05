; TEST-ONLY Inno Setup source. Never compile for a user machine or distribute output.
; All macros are provided by the hosted Windows acceptance runner.
#ifndef CI_Source
  #error CI_Source is required
#endif
#ifndef CI_Target
  #error CI_Target is required
#endif
#ifndef CI_Output
  #error CI_Output is required
#endif
#ifndef CI_OwnerFile
  #error CI_OwnerFile is required
#endif
#ifndef CI_Guid
  #error CI_Guid is required
#endif

[Setup]
AppId=UnboundVNC-CI-ONLY-{#CI_Guid}
AppName=UnboundVNC Viewer CI Native Installer Preview
AppVersion=0.0.0-ci
DefaultDirName={#CI_Target}
OutputDir={#CI_Output}
OutputBaseFilename=UnboundVNCViewer-CI-ONLY-Setup
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=none
UsePreviousAppDir=no
CreateUninstallRegKey=no
UpdateUninstallLogAppName=no
DisableDirPage=yes
DisableProgramGroupPage=yes
AllowNoIcons=yes
CloseApplications=no
RestartApplications=no
Compression=lzma
SolidCompression=yes
WizardStyle=modern
Uninstallable=yes

[Files]
Source: "{#CI_Source}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#CI_OwnerFile}"; DestDir: "{app}"; DestName: ".unboundvnc-ci-installer-owned"; Flags: ignoreversion

[Code]
function IsExactOwnedLocation: Boolean;
begin
  Result := CompareText(ExpandConstant('{app}'), '{#CI_Target}') = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not IsExactOwnedLocation then
    Result := 'CI-only installer refused any alternate /DIR destination.'
  else if DirExists(ExpandConstant('{app}')) then
    Result := 'CI-only installer refuses pre-existing destination.';
end;

function InitializeUninstall: Boolean;
var
  Marker: AnsiString;
begin
  Result := IsExactOwnedLocation and
    LoadStringFromFile(ExpandConstant('{app}\.unboundvnc-ci-installer-owned'), Marker) and
    (Trim(Marker) = '{#CI_Guid}');
end;
