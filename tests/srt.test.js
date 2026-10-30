const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSrt, formatTimecode, formatSrt } = require("../src/core/captions/srt.js");

test("exportar SRT: segmentos ou itens, numeração sem buracos, volta igual no parser", () => {
  const srt = formatSrt([
    { inSeconds: 1, outSeconds: 2.5, text: "Olá mundo" },
    { inSeconds: 3, outSeconds: 3, text: "sem duração" },
    { startMs: 4000, endMs: 5200, text: "Linha 1\nLinha 2" },
    { inSeconds: 6, outSeconds: 7, text: "   " },
  ]);
  assert.equal(srt, "1\r\n00:00:01,000 --> 00:00:02,500\r\nOlá mundo\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,200\r\nLinha 1\r\nLinha 2\r\n");
  const back = parseSrt(srt);
  assert.equal(back.errors.length, 0);
  assert.deepEqual(back.items.map((i) => [i.startMs, i.endMs, i.text]), [[1000, 2500, "Olá mundo"], [4000, 5200, "Linha 1\nLinha 2"]]);
  assert.equal(formatSrt([]), "");
});

test("parse básico com CRLF e BOM", () => {
  const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nOlá mundo\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nLinha 1\r\nLinha 2\r\n";
  const r = parseSrt(srt);
  assert.equal(r.errors.length, 0);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { index: 1, startMs: 1000, endMs: 2500, text: "Olá mundo" });
  assert.equal(r.items[1].text, "Linha 1\nLinha 2");
});

test("aceita ponto como separador de milissegundos e timecode sem horas", () => {
  const r = parseSrt("1\n00:01.500 --> 00:02.000\nteste\n");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].startMs, 1500);
  assert.equal(r.items[0].endMs, 2000);
});

test("bloco sem número de índice ainda funciona", () => {
  const r = parseSrt("00:00:00,000 --> 00:00:01,000\nsem índice");
  assert.equal(r.items.length, 1);
});

test("erros: fim <= início, bloco sem texto, bloco sem timecode", () => {
  const r = parseSrt(
    "1\n00:00:02,000 --> 00:00:01,000\ninvertido\n\n2\n00:00:03,000 --> 00:00:04,000\n\n3\nsem tempo\n\n4\n00:00:05,000 --> 00:00:06,000\nok",
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, "ok");
  assert.equal(r.errors.length, 3);
});

test("ordena cronologicamente", () => {
  const r = parseSrt("1\n00:00:05,000 --> 00:00:06,000\nB\n\n2\n00:00:01,000 --> 00:00:02,000\nA");
  assert.deepEqual(
    r.items.map((i) => i.text),
    ["A", "B"],
  );
});

test("arquivo vazio gera erro", () => {
  const r = parseSrt("   \n\n");
  assert.equal(r.items.length, 0);
  assert.equal(r.errors.length, 1);
});

test("formatTimecode", () => {
  assert.equal(formatTimecode(3723456), "01:02:03,456");
  assert.equal(formatTimecode(0), "00:00:00,000");
});
