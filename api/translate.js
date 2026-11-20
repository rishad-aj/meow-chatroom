/* Google Translate proxy (no API key needed) with MyMemory fallback.
   POST { texts: string[], target: "es" } -> { translations: string[], sameLang: boolean[] }
   Also accepts { text, target }. GET ?text=..&target=.. for quick tests.
   Google first (with detected source language check), MyMemory fallback when
   Google fails or echoes foreign text unchanged. */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  var texts = [];
  var target = "en";
  try {
    if (req.method === "GET") {
      if (req.query && req.query.text) texts = [String(req.query.text)];
      if (req.query && req.query.target) target = String(req.query.target);
    } else {
      var body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (Array.isArray(body.texts)) texts = body.texts.map(function (t) { return String(t); });
      else if (body.text != null) texts = [String(body.text)];
      if (body.target) target = String(body.target);
    }
  } catch (e) {}

  var TARGET_MAP = {
    zh: "zh-CN",
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
    fil: "tl",
    tl: "tl",
    iw: "he",
    he: "he"
  };

  function normTarget(tg) {
    tg = String(tg || "en").trim().toLowerCase().slice(0, 10);
    if (TARGET_MAP[tg]) return TARGET_MAP[tg];
    return tg || "en";
  }

  function baseLang(code) {
    var c = String(code || "").trim().toLowerCase();
    if (c === "iw") return "he";
    if (c === "fil") return "tl";
    return c.split("-")[0];
  }

  function normCompare(s) {
    return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  target = normTarget(target);
  texts = texts.slice(0, 20).map(function (t) { return String(t).slice(0, 600); });
  if (!texts.length) {
    res.status(200).json({ translations: [], sameLang: [] });
    return;
  }

  async function viaGoogle(t, tg) {
    if (!t.trim()) return { text: "", srcLang: "" };
    var u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tg) + "&dt=t&q=" + encodeURIComponent(t);
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 6000);
        var r;
        try { r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!r.ok) throw new Error("gtx " + r.status);
        var j = await r.json();
        var s = "";
        if (j && Array.isArray(j[0])) {
          for (var i = 0; i < j[0].length; i++) {
            if (j[0][i] && j[0][i][0]) s += j[0][i][0];
          }
        }
        var srcLang = (j && typeof j[2] === "string") ? j[2] : "";
        s = String(s || "").trim();
        if (s) return { text: s, srcLang: srcLang };
        throw new Error("empty");
      } catch (e) {
        if (attempt === 1) throw e;
        await new Promise(function (res2) { setTimeout(res2, 250); });
      }
    }
    return { text: "", srcLang: "" };
  }

  async function viaMyMemory(t, tg) {
    if (!t.trim()) return "";
    try {
      var mmTg = tg === "zh-CN" ? "zh-CN" : baseLang(tg);
      var u = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(t.slice(0, 450)) + "&langpair=autodetect%7C" + encodeURIComponent(mmTg);
      var ctrl = new AbortController();
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 7000);
      var r;
      try { r = await fetch(u, { signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      if (!r.ok) return "";
      var j = await r.json();
      if (j && Number(j.responseStatus) && Number(j.responseStatus) !== 200) return "";
      var s = j && j.responseData && String(j.responseData.translatedText || "").trim();
      if (!s) return "";
      if (/invalid|quota|mymemory warning|please select two distinct/i.test(s)) return "";
      return s;
    } catch (e) { return ""; }
  }

  async function one(t) {
    var trimmed = String(t || "").trim();
    if (!trimmed) return { text: t, sameLang: true };

    var g = null;
    try { g = await viaGoogle(trimmed, target); } catch (e) { g = null; }

    if (g && g.text) {
      var detectedSame = !!(g.srcLang && baseLang(g.srcLang) === baseLang(target));
      if (normCompare(g.text) !== normCompare(trimmed)) {
        return { text: g.text, sameLang: false };
      }
      if (detectedSame) {
        return { text: trimmed, sameLang: true };
      }
    }

    var m = await viaMyMemory(trimmed, target);
    if (m && m.trim()) {
      var mSame = normCompare(m) === normCompare(trimmed);
      return { text: m.trim(), sameLang: mSame };
    }

    if (g && g.text) {
      return { text: g.text, sameLang: normCompare(g.text) === normCompare(trimmed) };
    }
    return { text: trimmed, sameLang: false };
  }

  var out = new Array(texts.length);
  var sameLang = new Array(texts.length);
  var nextIdx = 0;
  var CONCURRENCY = Math.min(3, texts.length);

  async function worker() {
    while (nextIdx < texts.length) {
      var idx = nextIdx++;
      var r = await one(texts[idx]);
      out[idx] = r.text;
      sameLang[idx] = !!r.sameLang;
      if (nextIdx < texts.length) {
        await new Promise(function (resolve) { setTimeout(resolve, 60); });
      }
    }
  }

  var workers = [];
  for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  res.status(200).json({ translations: out, sameLang: sameLang });
};
