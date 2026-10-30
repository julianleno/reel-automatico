; Instalador do app sem Premiere (rascunho da fase 4 do estudo, docs/estudo-app-independente.md).
; Empacota a pasta que `npm run empacotar --prefix prototypes/reel-sem-premiere` monta.
; Por usuário, sem administrador, sem assinatura (o SmartScreen ainda vai avisar).
;   ISCC /DAppVersion=0.10.5 installer\ReelAutomatico-Setup.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define SourceDir "..\prototypes\reel-sem-premiere\out\Reel automatico"

[Setup]
AppId={{6D2F7B8E-4C1A-4E57-9B3A-REELAUTOMATICO}
AppName=Reel automático
AppVersion={#AppVersion}
AppPublisher=RealFX
DefaultDirName={localappdata}\Programs\Reel automatico
DefaultGroupName=Reel automático
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupIconFile=realfx.ico
UninstallDisplayIcon={app}\resources\app\installer\realfx.ico
OutputDir=out
OutputBaseFilename=ReelAutomatico-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar um atalho na área de trabalho"; GroupDescription: "Atalhos:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Reel automático"; Filename: "{app}\Reel automatico.exe"; IconFilename: "{app}\resources\app\installer\realfx.ico"
Name: "{autodesktop}\Reel automático"; Filename: "{app}\Reel automatico.exe"; IconFilename: "{app}\resources\app\installer\realfx.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\Reel automatico.exe"; Description: "Abrir o Reel automático"; Flags: nowait postinstall skipifsilent
