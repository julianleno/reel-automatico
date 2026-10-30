/**
 * IA do painel (Claude Haiku), duas tarefas; só o texto sai do computador, nunca o áudio:
 *   keys  destaques: as posições das palavras que merecem cor, zoom e som (pickKeyWords);
 *   cuts  Corte Inteligente Boost: o que cortar do bruto (ensaio, fala fora do vídeo, retake,
 *         vício), lendo a transcrição com as pausas (findCuts).
 * (Mais: post, clips e motion, as opções do Criar Motion em volta da agulha; reel, o Reel na
 * duração pedida a partir de um bruto longo: planReel.)
 * Sem acesso ou com erro, quem chama segue com as regras locais do core.
 *
 * Dois caminhos:
 *   { code }  testador: pela função do Supabase (supabase/functions/ai-destaques), que guarda
 *             a chave da Anthropic, conta o gasto e devolve as correções dele como exemplos;
 *   { key }   desenvolvimento: direto na API com ANTHROPIC_API_KEY do ambiente.
 *
 * HTTP direto, sem o SDK: o painel é JS puro carregado por <script>, sem build nem npm.
 *
 * Global no painel: AppLegendasAI. No Node (testes): module.exports.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory(require);
  } else {
    var nodeRequire = (root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null);
    root.AppLegendasAI = factory(nodeRequire);
  }
})(typeof self !== "undefined" ? self : this, function (nodeRequire) {
  var API_URL = "https://api.anthropic.com/v1/messages";
  var FUNCTION_URL = "https://ggcukbtgvnkeixmpbsmu.supabase.co/functions/v1/ai-destaques";
  var PUBLIC_KEY = "sb_publishable_Hn7nXYorUxjVbNO4QyM3jg_Eqcb4GrS"; // a mesma do feedback (js/feedback.js)
  var MODEL = "claude-haiku-5-5";
  // SYSTEM e SCHEMA têm cópia na função do Supabase; tests/ai.test.js confere que são iguais.
  var SYSTEM =
    "Você ajuda a editar vídeos curtos (Reels, TikTok, Shorts) em português. Recebe a fala de um " +
    "vídeo, uma frase por linha no formato {s}: [n]palavra [n]palavra… Para cada frase, decida " +
    "se ela tem uma palavra que um bom editor destacaria na legenda e com um zoom: a palavra que " +
    "carrega a força da frase (o número, o nome, a promessa, a emoção, a virada). Se tiver, " +
    "devolva {sentence: s, word: n} com essa única palavra. Pule frases de transição, " +
    "apresentação ou sem nada forte; destacar demais tira a força do destaque. Nunca escolha " +
    "artigos, preposições, pronomes, verbos comuns, conectivos ou vícios como né, tipo, então.";
  var SCHEMA = {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: { sentence: { type: "integer" }, word: { type: "integer" } },
          required: ["sentence", "word"],
          additionalProperties: false,
        },
      },
    },
    required: ["picks"],
    additionalProperties: false,
  };

  var SYSTEM_CUTS =
    "Você é editor de vídeos curtos (Reels, TikTok, Shorts) em português. Recebe a transcrição " +
    "de um vídeo BRUTO, um trecho por linha (as linhas se separam nas pausas da fala), no formato " +
    "{t}: [mm:ss] [n]palavra [n]palavra… Marque o que um bom editor cortaria para o vídeo final " +
    "ficar limpo, sem perder conteúdo. Motivos: ensaio (testando a frase, lendo o roteiro, " +
    "contando um, dois, três, começando e parando); fora (fala que não é do vídeo: conversa com " +
    "quem grava, comentário sobre a gravação, deixa eu ver, corta, acho que ficou bom); retake " +
    "(trecho dito de novo depois, mesmo com outras palavras, como uma pergunta refeita: corte " +
    "as tentativas anteriores e mantenha a última versão completa); vicio (hã, é, tipo, né, então soltos que não fazem falta, palavra gaguejada). " +
    "Nunca corte conteúdo que só aparece uma vez. Repetição de propósito, para dar ênfase (nós " +
    "temos uma mãe, nós temos uma protetora), não é retake. Na dúvida, não corte. Devolva cada " +
    "corte como {from, to, reason, note}: from e to são os números da primeira e da última " +
    "palavra cortada, reason é ensaio, fora, retake ou vicio, e note diz o porquê em poucas palavras.";
  var SCHEMA_CUTS = {
    type: "object",
    properties: {
      cuts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "integer" },
            to: { type: "integer" },
            reason: { type: "string", enum: ["ensaio", "fora", "retake", "vicio"] },
            note: { type: "string" },
          },
          required: ["from", "to", "reason", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["cuts"],
    additionalProperties: false,
  };
  var SYSTEM_POST =
    "Você escreve o texto de publicação de vídeos curtos (Reels, TikTok, Shorts) em português do " +
    "Brasil. Recebe a fala do vídeo. Devolva title, um título de até 60 caracteres que diz do que " +
    "o vídeo trata; caption, a legenda do post em 2 a 4 frases curtas, em que a primeira é um " +
    "gancho que faz a pessoa parar de rolar e a última chama para comentar, salvar ou seguir; e " +
    "hashtags, de 5 a 8, sem o símbolo #, em minúsculas, sobre o assunto do vídeo, misturando " +
    "amplas e específicas. Escreva no tom de quem fala no vídeo. Use só o que está na fala: não " +
    "invente fatos, números, promessas nem nomes. No máximo dois emojis. Se a fala vier em " +
    "linhas que começam com [m:ss] (vídeo longo), devolva também chapters, os capítulos do " +
    "YouTube: de 3 a 10, na ordem do vídeo, o primeiro em 0, cada um com at, o segundo em que " +
    "começa uma das linhas, e title, até 40 caracteres. Sem essas marcas, chapters vazio.";
  var SCHEMA_POST = {
    type: "object",
    properties: {
      title: { type: "string" },
      caption: { type: "string" },
      hashtags: { type: "array", items: { type: "string" } },
      chapters: {
        type: "array",
        items: {
          type: "object",
          properties: { at: { type: "integer" }, title: { type: "string" } },
          required: ["at", "title"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "caption", "hashtags", "chapters"],
    additionalProperties: false,
  };
  var SYSTEM_CLIPS =
    "Você é editor de cortes para Shorts, Reels e TikTok em português. Recebe a transcrição de um " +
    "vídeo longo (podcast, aula, entrevista, live), um trecho por linha (as linhas se separam nas " +
    "pausas) no formato {t}: [mm:ss] [n]palavra [n]palavra… Escolha de 1 a 5 trechos que funcionam " +
    "sozinhos como vídeo curto: começam numa frase que prende nos primeiros segundos (pergunta, " +
    "afirmação forte, número, conflito, começo de história), têm uma ideia completa e terminam numa " +
    "frase fechada, sem depender do que veio antes. Cada trecho entre 20 e 60 segundos. Use só o que " +
    "foi dito, não invente. Devolva cada trecho como {from, to, title, hook, score}: from e to são os " +
    "números da primeira e da última palavra; title tem até 60 caracteres; hook diz em poucas palavras " +
    "por que prende; score, de 1 a 10, é o potencial de o trecho viralizar sozinho.";
  var SCHEMA_CLIPS = {
    type: "object",
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "integer" },
            to: { type: "integer" },
            title: { type: "string" },
            hook: { type: "string" },
            score: { type: "integer" },
          },
          required: ["from", "to", "title", "hook", "score"],
          additionalProperties: false,
        },
      },
    },
    required: ["clips"],
    additionalProperties: false,
  };
  var SYSTEM_MOTION =
    "Você é motion designer de vídeos curtos (Reels, TikTok, Shorts) em português. O editor pôs a " +
    "agulha num ponto do vídeo e quer um motion ali. Recebe o tipo (tela inteira: a animação cobre " +
    "o vídeo e explica a fala; junto com a pessoa: um elemento por cima do vídeo, na parte de cima, " +
    "sem tapar o rosto), a marca (nicho e tipo de vídeo), o pedido do editor (pode vir vazio) e a " +
    "fala em volta da agulha, com [agulha] onde ela está; o motion entra na agulha, então use o " +
    "que é dito logo depois dela. Proponha de 2 a 3 opções diferentes entre si, cada uma com um " +
    "destes modelos: numero (um número grande que conta até o valor, com uma linha curta embaixo; " +
    "quando a fala tem número, valor, porcentagem ou tempo), titulo (um título curto com uma linha " +
    "de apoio; para a ideia central, um tema, o nome de alguém), lista (de 2 a 4 itens curtos que " +
    "entram um a um; quando a fala enumera passos, motivos ou opções). Preencha template; main, o " +
    "número com a unidade (como R$ 50 mil ou 3x) ou o título, até 28 caracteres; sub, a linha de " +
    "apoio, até 40 caracteres, pode ser vazia; items, só na lista, até 24 caracteres cada, vazio " +
    "nos outros; seconds, de 2 a 6, o tempo que a fala fica no assunto; e why, em poucas palavras " +
    "para o editor, por que essa opção. Use só o que está na fala ou no pedido: não invente " +
    "números, nomes nem promessas. Escreva no tom da marca. Se vier um ajuste do editor sobre " +
    "opções anteriores, siga o ajuste.";
  var SCHEMA_MOTION = {
    type: "object",
    properties: {
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            template: { type: "string", enum: ["numero", "titulo", "lista"] },
            main: { type: "string" },
            sub: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            seconds: { type: "integer" },
            why: { type: "string" },
          },
          required: ["template", "main", "sub", "items", "seconds", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["options"],
    additionalProperties: false,
  };
  // Reel na duração pedida: os trechos do bruto que fazem um Reel sozinho (planReel). Cópia na função.
  var SYSTEM_REEL =
    "Você é editor de Reels, TikTok e Shorts em português. Recebe a transcrição de um vídeo BRUTO, um " +
    "trecho por linha (as linhas se separam nas pausas da fala), no formato {t}: [início-fim em segundos] " +
    "[n]palavra [n]palavra…, e na primeira linha a duração-alvo do Reel. Monte o melhor Reel com essa " +
    "duração escolhendo trechos do bruto, na ordem em que foram ditos. O Reel precisa fazer sentido sozinho: " +
    "começa no que prende (pergunta, promessa, número, conflito, começo de história), tem uma ideia " +
    "completa e termina numa frase fechada. De cada fala repetida (tentativa, retake) use só a última " +
    "versão completa. Deixe de fora ensaio, conversa fora do vídeo, vícios e frases que não fazem falta. " +
    "Corte só entre frases ou orações, nunca no meio de uma ideia, e não deixe trecho de uma palavra só. " +
    "A soma dos trechos fica entre 85% e 110% da duração-alvo, contando a fala sem as pausas; se o que é " +
    "bom no bruto for mais curto, use todo o bom. Escolha também de 2 a 6 palavras para zoom (o número, a " +
    "promessa, a virada, a emoção), com pelo menos 4 segundos entre elas. Use só o que foi dito, não " +
    "invente. Devolva segments, cada um {from, to} com os números da primeira e da última palavra, em " +
    "ordem; zooms, os números das palavras; title, até 60 caracteres; e hook, a frase curta da capa, até " +
    "70 caracteres.";
  var SCHEMA_REEL = {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: { from: { type: "integer" }, to: { type: "integer" } },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
      zooms: { type: "array", items: { type: "integer" } },
      title: { type: "string" },
      hook: { type: "string" },
    },
    required: ["segments", "zooms", "title", "hook"],
    additionalProperties: false,
  };
  // Pensamento + resposta: os cortes leem o bruto inteiro; o post é curto.
  var TASKS = {
    keys: { system: SYSTEM, schema: SCHEMA, maxTokens: 8000 },
    cuts: { system: SYSTEM_CUTS, schema: SCHEMA_CUTS, maxTokens: 16000 },
    post: { system: SYSTEM_POST, schema: SCHEMA_POST, maxTokens: 4000 },
    clips: { system: SYSTEM_CLIPS, schema: SCHEMA_CLIPS, maxTokens: 8000 },
    motion: { system: SYSTEM_MOTION, schema: SCHEMA_MOTION, maxTokens: 4000 },
    reel: { system: SYSTEM_REEL, schema: SCHEMA_REEL, maxTokens: 16000 },
  };
  var PAUSE_LINE_MS = 700; // pausa que separa os trechos (as tomadas) na transcrição enviada

  var cache = {}; // texto numerado -> posições (zoom e sons reaproveitam a escolha das legendas)

  var envKeyRefused = false; // a API recusou a chave do ambiente: até reabrir o painel, só o código vale

  // Chave do ambiente (ANTHROPIC_API_KEY), para quem já tem uma configurada no Windows.
  function rawEnvKey() {
    try {
      return String(nodeRequire("process").env.ANTHROPIC_API_KEY || "");
    } catch (e) {
      return "";
    }
  }
  function envKey() {
    return envKeyRefused ? "" : rawEnvKey();
  }

  /**
   * segments -> uma frase por linha: "0: [0]Hoje [1]eu [2]ganhei [3]R$ [4]500." (todas as
   * palavras, em ordem; a frase termina em . ! ? …). sentenceOf[n] = frase da palavra n.
   */
  function numberedText(segments) {
    var lines = [];
    var line = [];
    var sentenceOf = [];
    (segments || []).forEach(function (seg) {
      (seg.words || []).forEach(function (w) {
        var text = String(w.text || "").replace(/\s+/g, " ");
        sentenceOf.push(lines.length);
        line.push("[" + (sentenceOf.length - 1) + "]" + text);
        if (/[.!?…]["”')]?$/.test(text)) {
          lines.push(lines.length + ": " + line.join(" "));
          line = [];
        }
      });
    });
    if (line.length) lines.push(lines.length + ": " + line.join(" "));
    return { text: lines.join("\n"), count: sentenceOf.length, sentenceOf: sentenceOf };
  }

  function buildRequest(text, task) {
    var t = TASKS[task] || TASKS.keys;
    return {
      model: MODEL,
      max_tokens: t.maxTokens, // o pensamento conta aqui; a resposta em si é curta
      system: t.system,
      // "low" oscilou entre rodadas (2 a 11 destaques no mesmo vídeo); "medium" repetiu o resultado
      output_config: { effort: "medium", format: { type: "json_schema", schema: t.schema } },
      messages: [{ role: "user", content: text }],
    };
  }

  function answerOf(response) {
    if (response.stop_reason === "refusal") throw new Error("a IA recusou o pedido");
    if (response.stop_reason === "max_tokens") throw new Error("resposta cortada (vídeo longo demais?)");
    var block = (response.content || []).filter(function (b) { return b.type === "text"; })[0];
    if (!block) throw new Error("resposta sem texto");
    // dado externo: JSON quebrado ou que não é um objeto vira o mesmo erro claro para o editor
    var answer;
    try {
      answer = JSON.parse(block.text);
    } catch (e) {
      throw new Error("resposta fora do formato");
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("resposta fora do formato");
    return answer;
  }

  // Resposta da API -> posições válidas, no máximo uma por frase, em ordem. A resposta é dado
  // externo: a palavra precisa existir e estar na frase indicada.
  function parseKeys(response, numbered) {
    var picks = answerOf(response).picks;
    if (!Array.isArray(picks)) throw new Error("resposta fora do formato");
    var used = {};
    var keys = [];
    picks.forEach(function (p) {
      var w = p && p.word;
      if (typeof w !== "number" || w % 1 !== 0 || w < 0 || w >= numbered.count) return;
      if (numbered.sentenceOf[w] !== p.sentence || used[p.sentence]) return;
      used[p.sentence] = true;
      keys.push(w);
    });
    return keys.sort(function (a, b) { return a - b; });
  }

  // Pedido à função do Supabase (testador).
  async function callFunction(payload, fetchImpl) {
    var res = await (fetchImpl || fetch)(FUNCTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY },
      body: JSON.stringify(payload),
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      // função do servidor mais velha que o painel (falta o redeploy de ai-destaques)
      if (/tarefa desconhecida/i.test(body.error || "")) throw new Error("o servidor da IA ainda não tem esta função; atualize a função ai-destaques");
      throw new Error(res.status === 401 ? "código de acesso da IA inválido" : body.error || "HTTP " + res.status);
    }
    return body;
  }

  // Desenvolvimento direto na API; testador pela função. Chave do ambiente recusada (vencida) com
  // código salvo no painel: segue pelo código. Devolve a resposta da API como veio.
  async function ask(auth, task, text, fetchImpl) {
    if (!auth.key) return callFunction({ code: auth.code, task: task, text: text }, fetchImpl);
    var body;
    {
      var res = await (fetchImpl || fetch)(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": auth.key,
          "anthropic-version": "2023-06-01",
          // modo de desenvolvimento: a chave é do próprio dev, no ambiente da máquina dele
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(buildRequest(text, task)),
      });
      body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        // chave vencida no Windows: sem isso o rodapé dizia "IA ativa" e o ⚡ não pedia o código
        var fromEnv = res.status === 401 && auth.key === rawEnvKey();
        if (fromEnv) envKeyRefused = true;
        if (res.status === 401 && auth.code) return callFunction({ code: auth.code, task: task, text: text }, fetchImpl);
        var why = body.error && body.error.message ? body.error.message : "HTTP " + res.status;
        if (fromEnv) throw new Error("chave da API inválida (a ANTHROPIC_API_KEY do Windows foi recusada); cole o código de acesso da IA no ⚡ do rodapé");
        throw new Error(res.status === 401 ? "chave da API inválida" : why);
      }
    }
    return body;
  }

  // access: { code } ou { key }; uma string é chave (desenvolvimento).
  async function pickKeyWords(access, segments, fetchImpl) {
    var auth = typeof access === "string" ? { key: access } : access || {};
    var n = numberedText(segments);
    if (!n.count) return [];
    if (cache[n.text]) return cache[n.text];
    cache[n.text] = parseKeys(await ask(auth, "keys", n.text, fetchImpl), n);
    return cache[n.text];
  }

  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return (s < 600 ? "0" : "") + Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  /**
   * words [{ text, startMs, endMs }] -> um trecho por linha, quebrando nas pausas de
   * PAUSE_LINE_MS: "0: [00:03] [0]Hoje [1]eu [2]vou". As pausas mostram as tomadas.
   */
  function cutText(words) {
    var lines = [];
    var line = [];
    (words || []).forEach(function (w, i) {
      if (line.length && w.startMs - words[i - 1].endMs >= PAUSE_LINE_MS) {
        lines.push(line);
        line = [];
      }
      if (!line.length) line.push(lines.length + ": [" + clock(w.startMs) + "]");
      line.push("[" + i + "]" + String(w.text || "").replace(/\s+/g, " "));
    });
    if (line.length) lines.push(line);
    return lines.map(function (l) { return l.join(" "); }).join("\n");
  }

  // Resposta -> cortes válidos, em ordem e sem sobreposição. Dado externo: confere tudo.
  function parseCuts(response, count) {
    var cuts = answerOf(response).cuts;
    if (!Array.isArray(cuts)) throw new Error("resposta fora do formato");
    var ok = cuts.filter(function (c) {
      var whole = function (n) { return typeof n === "number" && n % 1 === 0; };
      return c && whole(c.from) && whole(c.to) && c.from >= 0 && c.to < count && c.from <= c.to && /^(ensaio|fora|retake|vicio)$/.test(c.reason);
    }).sort(function (a, b) { return a.from - b.from; });
    var out = [];
    ok.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && c.from <= last.to) return;
      out.push({ from: c.from, to: c.to, reason: c.reason, note: String(c.note || "").slice(0, 120) });
    });
    return out;
  }

  // Corte Inteligente Boost: words (da transcrição) -> [{ from, to, reason, note }]
  async function findCuts(access, words, fetchImpl) {
    if (!words || !words.length) return [];
    return parseCuts(await ask(access || {}, "cuts", cutText(words), fetchImpl), words.length);
  }

  // Resposta -> { title, caption, hashtags } limpos. Dado externo: textos com limite (o Instagram
  // aceita 2.200 caracteres na legenda), hashtags sem #, sem espaço, sem repetir, até 10.
  function parsePost(response) {
    var a = answerOf(response) || {};
    if (typeof a.title !== "string" || typeof a.caption !== "string" || !Array.isArray(a.hashtags)) throw new Error("resposta fora do formato");
    var seen = {};
    var tags = [];
    a.hashtags.forEach(function (h) {
      var tag = String(h || "").replace(/^#+/, "").replace(/\s+/g, "").toLowerCase();
      if (!tag || seen[tag] || tags.length >= 10) return;
      seen[tag] = true;
      tags.push(tag);
    });
    return { title: a.title.trim().slice(0, 100), caption: a.caption.trim().slice(0, 2200), hashtags: tags, chapters: parseChapters(a.chapters) };
  }

  // Regras do YouTube: o primeiro em 0:00, pelo menos 3, cada um com 10 s ou mais. Fora disso, [].
  // Servidor antigo (sem capítulos) também dá [].
  function parseChapters(list) {
    var out = [];
    (Array.isArray(list) ? list : []).filter(function (c) {
      return c && typeof c.at === "number" && c.at % 1 === 0 && c.at >= 0 && typeof c.title === "string" && c.title.trim();
    }).sort(function (x, y) { return x.at - y.at; }).forEach(function (c) {
      var at = out.length ? c.at : 0;
      if (out.length && at < out[out.length - 1].at + 10) return;
      out.push({ at: at, title: c.title.trim().slice(0, 60) });
    });
    return out.length >= 3 ? out : [];
  }

  function clockOf(seconds) {
    var s = Math.floor(seconds);
    var h = Math.floor(s / 3600);
    var mm = ("0" + Math.floor((s % 3600) / 60)).slice(h ? -2 : -1);
    return (h ? h + ":" : "") + mm + ":" + ("0" + (s % 60)).slice(-2);
  }

  // "0:00 Abertura\n1:23 ..." para colar na descrição do YouTube.
  function chaptersText(chapters) {
    return (chapters || []).map(function (c) { return clockOf(c.at) + " " + c.title; }).join("\n");
  }

  var CHAPTERS_FROM_MS = 180000; // capítulos só em vídeo de 3 min ou mais
  var POST_MAX_CHARS = 55000; // abaixo do limite da função (60 mil)

  // A fala para o post: corrida, ou, em vídeo longo, uma linha por pausa com o [m:ss] do começo
  // (o tempo é do vídeo, contado da primeira palavra).
  function postText(words) {
    var list = (words || []).filter(function (w) { return String(w.text || "").trim(); });
    if (!list.length) return "";
    var t0 = list[0].startMs;
    if (list[list.length - 1].endMs - t0 < CHAPTERS_FROM_MS) {
      return list.map(function (w) { return String(w.text); }).join(" ").replace(/\s+/g, " ").trim();
    }
    var lines = [];
    var line = null;
    list.forEach(function (w, i) {
      if (!line || w.startMs - list[i - 1].endMs >= PAUSE_LINE_MS) {
        line = { at: Math.floor((w.startMs - t0) / 1000), words: [] };
        lines.push(line);
      }
      line.words.push(String(w.text));
    });
    var render = function (keep) {
      return lines.map(function (l) {
        var ws = keep ? l.words.slice(0, keep) : l.words;
        return "[" + clockOf(l.at) + "] " + ws.join(" ").replace(/\s+/g, " ").trim() + (keep && l.words.length > keep ? " …" : "");
      }).join("\n");
    };
    // Vídeo muito longo (a função aceita 60 mil letras): o começo de cada trecho basta para o título
    // e os capítulos, e todas as marcas de tempo continuam lá.
    var out = render(0);
    for (var keep = 40; out.length > POST_MAX_CHARS && keep >= 4; keep = Math.floor(keep * 0.7)) out = render(keep);
    return out;
  }

  // Texto do post (título, legenda, hashtags) a partir das palavras da transcrição.
  async function writePost(access, words, fetchImpl) {
    var text = postText(words);
    if (!text) throw new Error("sem fala para escrever o post");
    return parsePost(await ask(access || {}, "post", text, fetchImpl));
  }

  var CLIP_MIN_MS = 10000;
  var CLIP_MAX_MS = 120000;

  // Resposta -> trechos válidos para Shorts, do maior score para o menor, sem sobreposição (fica o
  // de score maior), duração entre 10 s e 2 min, no máximo 5. Dado externo: confere tudo.
  function parseClips(response, words) {
    var clips = answerOf(response).clips;
    if (!Array.isArray(clips)) throw new Error("resposta fora do formato");
    var whole = function (n) {
      return typeof n === "number" && n % 1 === 0;
    };
    var ok = clips.filter(function (c) {
      if (!c || !whole(c.from) || !whole(c.to) || c.from < 0 || c.to >= words.length || c.from > c.to) return false;
      var ms = words[c.to].endMs - words[c.from].startMs;
      return ms >= CLIP_MIN_MS && ms <= CLIP_MAX_MS;
    }).map(function (c) {
      return {
        from: c.from,
        to: c.to,
        title: String(c.title || "").trim().slice(0, 100),
        hook: String(c.hook || "").trim().slice(0, 140),
        score: Math.max(1, Math.min(10, whole(c.score) ? c.score : 5)),
      };
    }).sort(function (a, b) {
      return b.score - a.score;
    });
    var out = [];
    ok.forEach(function (c) {
      if (out.length >= 5) return;
      if (out.some(function (o) { return c.from <= o.to && c.to >= o.from; })) return;
      out.push(c);
    });
    return out;
  }

  // Melhores trechos de um vídeo longo para virar Shorts: words (da transcrição) -> parseClips.
  async function findClips(access, words, fetchImpl) {
    if (!words || !words.length) return [];
    return parseClips(await ask(access || {}, "clips", cutText(words), fetchImpl), words);
  }

  // ------------------------------------------------------------------ Reel na duração pedida

  function seconds1(ms) {
    return (Math.max(0, ms) / 1000).toFixed(1);
  }

  // A meta na 1ª linha e um trecho por linha, quebrando nas pausas, com início e fim em segundos
  // (a IA soma a duração): "0: [3.2-7.9] [0]Hoje [1]eu [2]vou".
  function reelText(words, seconds) {
    var lines = [];
    var line = null;
    (words || []).forEach(function (w, i) {
      if (line && w.startMs - words[i - 1].endMs >= PAUSE_LINE_MS) {
        lines.push(line);
        line = null;
      }
      if (!line) line = { start: w.startMs, end: w.endMs, parts: [] };
      line.end = w.endMs;
      line.parts.push("[" + i + "]" + String(w.text || "").replace(/\s+/g, " "));
    });
    if (line) lines.push(line);
    return ["Duração-alvo: " + Math.round(seconds) + " s"].concat(lines.map(function (l, k) {
      return k + ": [" + seconds1(l.start) + "-" + seconds1(l.end) + "] " + l.parts.join(" ");
    })).join("\n");
  }

  // Resposta -> { segments, zooms, title, hook } válidos: trechos em ordem e sem sobreposição, zooms
  // dentro de um trecho e com 4 s entre eles. Dado externo: confere tudo.
  function parseReel(response, words) {
    var a = answerOf(response);
    if (!Array.isArray(a.segments)) throw new Error("resposta fora do formato");
    var whole = function (n) {
      return typeof n === "number" && n % 1 === 0;
    };
    var segments = [];
    a.segments.filter(function (s) {
      return s && whole(s.from) && whole(s.to) && s.from >= 0 && s.to < words.length && s.from <= s.to;
    }).sort(function (x, y) {
      return x.from - y.from;
    }).forEach(function (s) {
      var last = segments[segments.length - 1];
      if (last && s.from <= last.to) return;
      segments.push({ from: s.from, to: s.to });
    });
    var zooms = [];
    (Array.isArray(a.zooms) ? a.zooms : []).filter(whole).sort(function (x, y) { return x - y; }).forEach(function (n) {
      var inside = segments.some(function (s) { return n >= s.from && n <= s.to; });
      var last = zooms[zooms.length - 1];
      if (inside && (last === undefined || words[n].startMs - words[last].startMs >= 4000)) zooms.push(n);
    });
    var text = function (v, max) {
      return String(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);
    };
    return { segments: segments, zooms: zooms, title: text(a.title, 60), hook: text(a.hook, 70) };
  }

  function reelPlan() {
    if (typeof AppLegendasReelPlan !== "undefined") return AppLegendasReelPlan; // eslint-disable-line no-undef
    return nodeRequire(nodeRequire("path").join(__dirname, "../../../../core/video/reel-plan.js"));
  }

  /**
   * Reel na duração pedida a partir do bruto: words (transcrição) -> { segments: [{ from, to }],
   * zooms: [n], title, hook, removed: [{ from, to }], source }. source "reel": a tarefa própria;
   * "cuts"/"clips": servidor sem ela, então tira o que a IA mandou cortar e, se o bom ainda passar
   * da meta, junta os melhores trechos (findClips); "local": sem IA (o chamador decide se usa).
   */
  async function planReel(access, words, seconds, fetchImpl) {
    var Plan = reelPlan();
    var target = seconds * 1000;
    if (!words || !words.length) return { segments: [], zooms: [], title: "", hook: "", removed: [], source: "local" };
    var auth = access || {};
    try {
      var r = parseReel(await ask(auth, "reel", reelText(words, seconds), fetchImpl), words);
      var fitted = r.segments.length ? Plan.trimTo(Plan.minus(r.segments, [], words), words, target) : [];
      // a tarefa própria ainda não foi medida em bruto de verdade: resposta curta demais (menos de 60%
      // da meta) cai no caminho testado (cortes + melhores trechos)
      if (fitted.length && Plan.totalMs(fitted, words) >= target * 0.6) {
        r.segments = fitted;
        r.removed = [];
        r.source = "reel";
        return r;
      }
    } catch (e) {
      if (!/ainda não tem esta função/.test(e.message)) throw e;
    }
    // vício não decide trecho: o corte palavra a palavra já tira; contando aqui, um "de" repetido partia a
    // frase e o resto dela ("um político.", curto) saía junto (1.MOV), e um "Como" de verdade sumia (Patrícia)
    var removed = (await findCuts(auth, words, fetchImpl)).filter(function (c) { return c.reason !== "vicio"; })
      .map(function (c) { return { from: c.from, to: c.to }; });
    var clean = Plan.minus([{ from: 0, to: words.length - 1 }], removed, words);
    if (Plan.totalMs(clean, words) <= target * 1.1) {
      return { segments: Plan.trimTo(clean, words, target), zooms: [], title: "", hook: "", removed: removed, source: "cuts" };
    }
    // o bom passa da meta: os melhores trechos, escolhidos só na fala que fica
    var index = [];
    clean.forEach(function (s) {
      for (var i = s.from; i <= s.to; i += 1) index.push(i);
    });
    var cleanWords = index.map(function (i) { return words[i]; });
    var clips = (await findClips(auth, cleanWords, fetchImpl)).map(function (c) {
      return Object.assign({}, c, { from: index[c.from], to: index[c.to] });
    });
    var segments = Plan.choose(clips, words, target, removed);
    if (!segments.length) segments = Plan.fallback(words, target, removed);
    var best = clips[0] || {};
    return { segments: segments, zooms: [], title: best.title || "", hook: best.hook || "", removed: removed, source: "clips" };
  }

  var MOTION_AROUND_MS = 12000; // fala lida antes e depois da agulha

  /**
   * O pedido do Criar Motion: tipo, marca, pedido do editor e a fala em volta da agulha.
   * o: { words, atMs, kind: "tela" | "pessoa", brand: { niche, videoType }, ask, previous: [opção] }
   * Com previous, ask é o ajuste do editor sobre aquelas opções.
   */
  function motionText(o) {
    var brand = o.brand || {};
    var near = (o.words || []).filter(function (w) {
      return w.startMs >= o.atMs - MOTION_AROUND_MS && w.startMs <= o.atMs + MOTION_AROUND_MS;
    });
    var speech = [];
    var marked = false;
    near.forEach(function (w) {
      if (!marked && w.startMs >= o.atMs) {
        speech.push("[agulha]");
        marked = true;
      }
      speech.push(String(w.text || "").replace(/\s+/g, " ").trim());
    });
    if (!marked) speech.push("[agulha]");
    var ask = String(o.ask || "").trim().slice(0, 500);
    var lines = [
      "Tipo: " + (o.kind === "tela" ? "tela inteira" : "junto com a pessoa"),
      "Marca: nicho " + (String(brand.niche || "").trim().slice(0, 80) || "não informado") + "; vídeos de " + (String(brand.videoType || "").trim().slice(0, 80) || "não informado"),
    ];
    if (o.previous && o.previous.length) {
      lines.push("Opções anteriores: " + o.previous.map(function (p, i) {
        return (i + 1) + ") " + p.template + ": " + [p.main, p.sub].concat(p.items || []).filter(Boolean).join(" / ");
      }).join("; "));
      lines.push("Ajuste do editor: " + (ask || "outras opções"));
    } else {
      lines.push("Pedido do editor: " + (ask || "nenhum"));
    }
    lines.push("Fala em volta da agulha: " + speech.join(" ").replace(/\s+/g, " ").trim());
    return lines.join("\n");
  }

  // Resposta -> até 3 opções válidas, com textos e tempo nos limites. Dado externo: confere tudo;
  // lista com menos de 2 itens e título vazio caem.
  function parseMotion(response) {
    var options = answerOf(response).options;
    if (!Array.isArray(options)) throw new Error("resposta fora do formato");
    var text = function (v, max) {
      return String(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);
    };
    var out = [];
    options.forEach(function (o) {
      if (!o || !/^(numero|titulo|lista)$/.test(o.template) || out.length >= 3) return;
      var items = o.template === "lista" && Array.isArray(o.items) ? o.items.map(function (i) { return text(i, 40); }).filter(Boolean).slice(0, 5) : [];
      var main = text(o.main, 40);
      if (!main || (o.template === "lista" && items.length < 2)) return;
      var seconds = typeof o.seconds === "number" && isFinite(o.seconds) ? Math.round(o.seconds) : 4;
      out.push({ template: o.template, main: main, sub: text(o.sub, 60), items: items, seconds: Math.max(2, Math.min(8, seconds)), why: text(o.why, 140) });
    });
    if (!out.length) throw new Error("a IA não trouxe nenhuma opção usável");
    return out;
  }

  // Criar Motion: o de motionText -> opções [{ template, main, sub, items, seconds, why }].
  async function proposeMotion(access, o, fetchImpl) {
    return parseMotion(await ask(access || {}, "motion", motionText(o), fetchImpl));
  }

  // Quem pode usar a IA: chave do ambiente (desenvolvimento) ou o código do testador salvo.
  function accessFrom(settings) {
    var key = envKey();
    var code = ((settings || {}).ai || {}).code;
    if (key) return code ? { key: key, code: code } : { key: key };
    return code ? { code: code } : null;
  }

  // A escolha já feita para estas legendas, sem chamar a IA (o editor de linhas mostra).
  function cachedKeys(segments) {
    return cache[numberedText(segments).text] || null;
  }

  function ping(code, fetchImpl) {
    return callFunction({ code: code, task: "ping" }, fetchImpl);
  }

  // Correções do editor: [{ sentence, ai_word, chosen_word }] (chosen_word null = nenhum destaque).
  function sendCorrections(code, examples, fetchImpl) {
    return callFunction({ code: code, task: "feedback", examples: examples }, fetchImpl);
  }

  return {
    MODEL: MODEL,
    SYSTEM: SYSTEM,
    SCHEMA: SCHEMA,
    SYSTEM_CUTS: SYSTEM_CUTS,
    SCHEMA_CUTS: SCHEMA_CUTS,
    SYSTEM_POST: SYSTEM_POST,
    SCHEMA_POST: SCHEMA_POST,
    SYSTEM_CLIPS: SYSTEM_CLIPS,
    SCHEMA_CLIPS: SCHEMA_CLIPS,
    parseClips: parseClips,
    findClips: findClips,
    SYSTEM_MOTION: SYSTEM_MOTION,
    SYSTEM_REEL: SYSTEM_REEL,
    SCHEMA_REEL: SCHEMA_REEL,
    reelText: reelText,
    parseReel: parseReel,
    planReel: planReel,
    SCHEMA_MOTION: SCHEMA_MOTION,
    motionText: motionText,
    parseMotion: parseMotion,
    proposeMotion: proposeMotion,
    parsePost: parsePost,
    postText: postText,
    chaptersText: chaptersText,
    writePost: writePost,
    envKey: envKey,
    accessFrom: accessFrom,
    cutText: cutText,
    parseCuts: parseCuts,
    findCuts: findCuts,
    numberedText: numberedText,
    buildRequest: buildRequest,
    parseKeys: parseKeys,
    pickKeyWords: pickKeyWords,
    cachedKeys: cachedKeys,
    ping: ping,
    sendCorrections: sendCorrections,
  };
});
