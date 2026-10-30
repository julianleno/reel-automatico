# Reel automático

App para Windows que transforma um vídeo bruto num Reel pronto, sem Premiere: tira as pausas e as
repetições, põe legenda animada, zoom nos destaques, sons e música, e gera o MP4 em 9:16, 4:5 ou 1:1.

É a parte desktop do App Legendas (o painel do Premiere fica em outro repositório). O app usa o
mesmo núcleo do painel: `src/core` (legendas, áudio, vídeo), `src/adobe/cep/js/services` (whisper,
render da legenda, velocidade, recorte da pessoa, IA) e `src/motion-jota/trilha-jota.js` (música
com o drop na palavra-chave).

## Rodar

Precisa do Node 22 ou mais novo, no Windows.

```
npm run fetch:bin   # baixa o ffmpeg e o whisper para src/adobe/cep/bin
npm run setup       # instala o Electron e o MediaPipe do app
npm run reel        # abre a tela
```

Na tela: solte o vídeo, escolha o estilo e o formato e clique em "Fazer meu Reel". O Reel sai em
`Vídeos/Reel automático`. O modelo de voz do whisper fica em `%APPDATA%/AppLegendas/models`; se ele
não existir, o app baixa uma vez só e mostra o progresso.

Sem tela (linha de comando):

```
prototypes/reel-sem-premiere/node_modules/electron/dist/electron.exe prototypes/reel-sem-premiere --input "D:/bruto.mov" --seconds 60
```

Se o npm bloquear o download do Electron, rode `node prototypes/reel-sem-premiere/node_modules/electron/install.js`.

## Opções sem tela

| Opção | O que faz |
|---|---|
| `--input arquivo` | O vídeo bruto. Repita para vários vídeos (fila). |
| `--juntar` | Junta os vários vídeos num Reel só, na ordem. |
| `--out pasta` | Pasta de saída (padrão `saida/`). |
| `--style nome` | Estilo da legenda (qualquer modelo de `render.js`; padrão `professor`). |
| `--model small-q8\|small\|medium\|base` | Modelo do whisper. |
| `--seconds N` | Usa só os primeiros N segundos do bruto. |
| `--duracao N` | Faz o melhor Reel de N segundos. |
| `--repeticoes` | Tira também repetições, retakes, ensaio e fala fora do vídeo. |
| `--musica arquivo` | Música de fundo, abaixo da voz. |
| `--velocidade 1.25` | Acelera a fala sem mudar o tom. |
| `--duas` | Duas pessoas empilhadas (vídeo deitado). |
| `--atras` | Legenda atrás da pessoa. |
| `--topo "texto" --rodape "@perfil"` | Moldura da marca. |
| `--cor "#e63946"` | Cor da marca na palavra que está sendo dita. |
| `--previa` | Prévia rápida em 540x960. |
| `--sem-zoom`, `--sem-sons`, `--sem-olhar`, `--sem-quem-fala` | Desligam cada recurso. |

Ao lado do MP4 saem a capa (`<nome> capa.jpg`, 3 opções), o `.srt` e o `<nome> tempos.json` (tempo
de cada etapa, o que foi cortado e o texto de cada legenda).

## Como funciona

1. O whisper transcreve o áudio e as palavras são ajustadas ao som. As palavras de cada vídeo ficam
   guardadas, então a 2ª rodada não ouve de novo.
2. Os silêncios e as repetições viram os trechos que saem do vídeo.
3. As palavras vão para o tempo do vídeo cortado e viram as legendas.
4. Numa passada só, o canvas desenha a legenda e manda os quadros ao ffmpeg, que corta, faz o zoom,
   põe a legenda por cima e mistura voz, sons e música.

Em vídeo deitado (16:9), o app acha o rosto e recorta o 9:16 nele; num podcast, segue quem está
falando.

## Programa e instalador

```
npm run empacotar
```

Monta `prototypes/reel-sem-premiere/out/Reel automatico/` com o Electron, o ffmpeg, o whisper, os
sons e as fontes. Copie a pasta e abra `Reel automatico.exe`. Para o instalador (Inno Setup):

```
iscc /DAppVersion=0.10.6 installer\ReelAutomatico-Setup.iss
```

O instalador sai sem assinatura, então o SmartScreen do Windows avisa na 1ª vez.

## Testes

```
npm test                                     # testes do núcleo (os do ffmpeg precisam do fetch:bin)
node prototypes/reel-sem-premiere/teste-tela.js   # abre a janela e confere cada estado (~90 s)
```

## Licenças de terceiros

- Fontes em `src/adobe/cep/fonts`: SIL Open Font License (os arquivos `OFL-*.txt` estão na pasta).
- Malha do rosto (`modelos/face_landmarker.task`) e `@mediapipe/tasks-vision`: Apache-2.0.
- ffmpeg (build LGPL do BtbN) e whisper.cpp (MIT): baixados pelo `fetch:bin`, não ficam no repositório.

## Licença

Todos os direitos reservados. O código está aberto para leitura; usar, copiar ou distribuir precisa
de autorização do autor.
