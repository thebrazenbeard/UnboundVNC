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
#ifndef CI_ManifestFile
  #error CI_ManifestFile is required
#endif
#ifndef CI_ManifestHash
  #error CI_ManifestHash is required
#endif
#ifndef CI_ManifestCount
  #error CI_ManifestCount is required
#endif

[Setup]
AppId=UnboundVNC-CI-ONLY-{#CI_Guid}
AppName=UnboundVNC Viewer CI Native Installer Preview
AppVersion=0.0.0-ci
DefaultDirName={#CI_Target}
OutputDir={#CI_Output}
OutputBaseFilename=UnboundVNCViewer-CI-ONLY-Setup
PrivilegesRequired=lowest
; Omit PrivilegesRequiredOverridesAllowed: documented default is blank, i.e.
; neither 'commandline' nor 'dialog' privilege override is permitted.
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
Source: "{#CI_ManifestFile}"; DestDir: "{app}"; DestName: ".unboundvnc-ci-manifest"; Flags: ignoreversion

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

function ManifestEntry(const Row: String; var Rel, Hash: String): Boolean;
begin
  Result := (Length(Row) > 65) and (Copy(Row, 65, 1) = '|');
  if Result then begin
    Hash := Copy(Row, 1, 64);
    Rel := Copy(Row, 66, Length(Row) - 65);
  end;
end;

function IsOwnedManifestFile(const Rel, Full: String; const Lines: TArrayOfString): Boolean;
var
  I: Integer;
  EntryRel, EntryHash: String;
begin
  Result := False;
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    if not ManifestEntry(Lines[I], EntryRel, EntryHash) then Exit;
    if CompareText(EntryRel, Rel) = 0 then begin
      Result := CompareText(GetSHA256OfFile(Full), EntryHash) = 0;
      Exit;
    end;
  end;
end;

function IsOwnedDirectory(const Rel: String; const Lines: TArrayOfString): Boolean;
var
  I: Integer;
  EntryRel, EntryHash: String;
  Prefix: String;
begin
  Result := False;
  Prefix := Rel + '\';
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    if not ManifestEntry(Lines[I], EntryRel, EntryHash) then Exit;
    if CompareText(Copy(EntryRel, 1, Length(Prefix)), Prefix) = 0 then begin
      Result := True;
      Exit;
    end;
  end;
end;

function VerifiedOwnedTree(const Dir, Rel: String; const Lines: TArrayOfString): Boolean;
var
  Rec: TFindRec;
  ChildRel, Full: String;
begin
  Result := True;
  if FindFirst(AddBackslash(Dir) + '*', Rec) then begin
    try
      repeat
        if (Rec.Name <> '.') and (Rec.Name <> '..') then begin
          Full := AddBackslash(Dir) + Rec.Name;
          if Rel = '' then ChildRel := Rec.Name
            else ChildRel := Rel + '\' + Rec.Name;
          if (Rec.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then begin
            Result := False;
            Exit;
          end;
          if (Rec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin
            if not IsOwnedDirectory(ChildRel, Lines) or
                not VerifiedOwnedTree(Full, ChildRel, Lines) then begin
              Result := False;
              Exit;
            end;
          end else if (CompareText(ChildRel, '.unboundvnc-ci-installer-owned') <> 0) and
                      (CompareText(ChildRel, '.unboundvnc-ci-manifest') <> 0) and
                      (CompareText(ChildRel, 'unins000.exe') <> 0) and
                      (CompareText(ChildRel, 'unins000.dat') <> 0) and
                      not IsOwnedManifestFile(ChildRel, Full, Lines) then begin
            Result := False;
            Exit;
          end;
        end;
      until not FindNext(Rec);
    finally
      FindClose(Rec);
    end;
  end;
end;

function InitializeUninstall: Boolean;
var
  Marker: AnsiString;
  Lines: TArrayOfString;
  ManifestPath, Rel, Hash, Full: String;
  I: Integer;
begin
  Result := False;
  if not IsExactOwnedLocation or
      not LoadStringFromFile(ExpandConstant('{app}\.unboundvnc-ci-installer-owned'), Marker) or
      (Trim(Marker) <> '{#CI_Guid}') then Exit;
  ManifestPath := ExpandConstant('{app}\.unboundvnc-ci-manifest');
  if not FileExists(ManifestPath) or
      (CompareText(GetSHA256OfFile(ManifestPath), '{#CI_ManifestHash}') <> 0) or
      not LoadStringsFromFile(ManifestPath, Lines) then Exit;
  if GetArrayLength(Lines) <> {#CI_ManifestCount} then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    if not ManifestEntry(Lines[I], Rel, Hash) then Exit;
    Full := ExpandConstant('{app}\') + Rel;
    if not FileExists(Full) or (CompareText(GetSHA256OfFile(Full), Hash) <> 0) then Exit;
  end;
  if not FileExists(ExpandConstant('{app}\unins000.exe')) or
      not FileExists(ExpandConstant('{app}\unins000.dat')) then Exit;
  Result := VerifiedOwnedTree(ExpandConstant('{app}'), '', Lines);
end;
