/* 🌸 BLOOM v5 Mac 版：アーティファクトの道具（window.claude）の差し替え
 *
 * 🐾 Task の shim.js をコピーして BLOOM 用に直したもの。bloom5.html を書き換えずに動かす。
 * bloom_server.py がページの頭に差し込む。ページが使う道具を、このMacの中のサーバー（127.0.0.1:8940）につなぐ。
 *   - db     ：doc(…).get / set / update / delete、collection(…).add / doc / onSnapshot / get / where / orderBy / limit
 *              onSnapshot は 3秒ごとに読み直し（ページが裏にあるときは15秒ごと）、変わったときだけ呼ぶ
 *              書いた内容は、保存が終わるのを待たずにすぐ画面へ反映する（アーティファクトと同じ動き）
 *   - sample ：json(入力, 設定) / text(入力, 設定)。このMacの Claude Code（claude -p）が答える（タロ美との英会話・フレーズの英訳）
 *   - ほかの道具は null（＝この画面では使えない）を返す
 *
 * スマホ版（bloom-phone）でも同じこのファイルを使う。先に window.BLOOM_BACKEND（github.js）があれば、
 * サーバーに聞くかわりにそれに聞く。スマホ版では sample は null（＝「claude.ai で開くと使えます」と出る）
 */
(function () {
  "use strict";
  var API = "/api/db";
  var BE = window.BLOOM_BACKEND || null;
  var POLL_MS = BE ? BE.pollMs : 3000, POLL_HIDDEN_MS = BE ? BE.pollHiddenMs : 15000;
  var HDR = {"Content-Type": "application/json", "X-Bloom-Mac": "1"};
  var SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

  function dbErr(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function segs(path, kind) {
    if (typeof path !== "string" || !path) throw new TypeError("path must be a non-empty string");
    var s = path.split("/");
    if (s.length > 16) throw new TypeError("path has more than 16 segments");
    s.forEach(function (x) { if (!SEG.test(x) || x === "." || x === "..") throw new TypeError("bad path segment: " + x); });
    if (kind === "doc" && s.length % 2) throw new TypeError("document path needs an even number of segments (" + s.length + ")");
    if (kind === "col" && !(s.length % 2)) throw new TypeError("collection path needs an odd number of segments (" + s.length + ")");
    return s;
  }
  function deepMerge(base, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) deepMerge(base[k], v);
      else base[k] = clone(v);
    });
    return base;
  }
  function newId() {
    var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "";
    var r = new Uint8Array(20); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(r) : r.forEach(function (_, i) { r[i] = Math.random() * 256; });
    for (var i = 0; i < 20; i++) s += a[r[i] % a.length];
    return s;
  }

  // ---------------------------------------------------------------- サーバーとのやりとり
  function call(method, url, body) {
    if (BE) return BE.call(method, url, body).catch(function (e) { throw e && e.code ? e : dbErr("unavailable", String(e && e.message || e)); });
    var opt = {method: method, headers: HDR, cache: "no-store"};
    if (method !== "GET") opt.body = JSON.stringify(body || {});
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        var code = j.code === "not_found" ? "invalid_argument" : (j.code || (r.status >= 500 ? "unavailable" : "invalid_argument"));
        throw dbErr(code, j.error || ("HTTP " + r.status));
      });
    }, function () { throw dbErr("unavailable", "サーバーにつながりません"); });
  }

  // ---------------------------------------------------------------- 棚ごとの手元の写し
  var cols = {};      // 棚の名前 → {server: {id: data}, etag, loaded, listeners: [], timer, busy, lastKey}
  var pend = {};      // 文書の名前 → [{op, data}]（保存が終わっていない書き込み）
  var chains = {};    // 文書の名前 → 1文書ずつ順番に書くための約束

  function colOf(docPath) { var s = docPath.split("/"); return {col: s.slice(0, -1).join("/"), id: s[s.length - 1]}; }
  function C(name) {
    return cols[name] || (cols[name] = {server: {}, etag: null, loaded: false, listeners: [], timer: null, busy: null, snaps: {}});
  }
  function view(name) { // サーバーの中身に、保存中の書き込みを重ねたもの
    var c = C(name), out = {};
    Object.keys(c.server).forEach(function (id) { out[id] = c.server[id]; });
    Object.keys(pend).forEach(function (p) {
      var w = colOf(p); if (w.col !== name) return;
      pend[p].forEach(function (e) {
        if (e.op === "set") out[w.id] = clone(e.data);
        else if (e.op === "update") { if (out[w.id]) out[w.id] = deepMerge(clone(out[w.id]), e.data); }
        else if (e.op === "delete") delete out[w.id];
      });
    });
    return out;
  }
  function hasPending(name) { return Object.keys(pend).some(function (p) { return colOf(p).col === name && pend[p].length; }); }

  function docSnap(id, data, pendingWrites) {
    var json = JSON.stringify(data);
    return {
      id: id, exists: data !== undefined && data !== null,
      data: function () { return data == null ? undefined : JSON.parse(json); },
      metadata: {fromCache: false, hasPendingWrites: !!pendingWrites}
    };
  }
  function querySnap(list, prevIds, pendingWrites) {
    var docs = list.map(function (x) { return docSnap(x.id, x.data, pendingWrites); });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0, metadata: {fromCache: false, hasPendingWrites: !!pendingWrites},
      docChanges: function () {
        var out = [], now = {};
        docs.forEach(function (d, i) {
          now[d.id] = 1;
          var old = prevIds ? prevIds.indexOf(d.id) : -1;
          if (old < 0) out.push({type: "added", doc: d, oldIndex: -1, newIndex: i});
          else out.push({type: "modified", doc: d, oldIndex: old, newIndex: i});
        });
        (prevIds || []).forEach(function (id, i) { if (!now[id]) out.push({type: "removed", doc: docSnap(id, {}, false), oldIndex: i, newIndex: -1}); });
        return out;
      }
    };
  }
  function applyQuery(q, all) {
    // 文書ひとつの見張り：棚の中から、その文書だけを取り出す
    if (q.only) return all[q.only] !== undefined ? [{id: q.only, data: all[q.only]}] : [];
    var list = Object.keys(all).sort().map(function (id) { return {id: id, data: all[id]}; });
    q.filters.forEach(function (f) {
      list = list.filter(function (x) {
        var v = x.data[f.field], w = f.value;
        switch (f.op) {
          case "==": return JSON.stringify(v) === JSON.stringify(w);
          case "!=": return v !== undefined && JSON.stringify(v) !== JSON.stringify(w);
          case "<": return v < w; case "<=": return v <= w; case ">": return v > w; case ">=": return v >= w;
          case "in": return (w || []).some(function (y) { return JSON.stringify(y) === JSON.stringify(v); });
          case "not-in": return v !== undefined && !(w || []).some(function (y) { return JSON.stringify(y) === JSON.stringify(v); });
          case "array-contains": return Array.isArray(v) && v.some(function (y) { return JSON.stringify(y) === JSON.stringify(w); });
        }
        return true;
      });
    });
    if (q.order) {
      var k = q.order.field, d = q.order.dir === "desc" ? -1 : 1;
      list.sort(function (a, b) {
        var x = a.data[k], y = b.data[k];
        if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1;
        return x < y ? -d : x > y ? d : 0;
      });
    }
    if (q.lim) list = list.slice(0, q.lim);
    return list;
  }

  function notify(name) {
    var c = C(name); if (!c.loaded) return;
    var all = view(name), pw = hasPending(name);
    c.listeners.slice().forEach(function (L) {
      var list = applyQuery(L.q, all), key = JSON.stringify(list);
      if (key === L.lastKey) return;
      var prev = L.lastIds; L.lastKey = key; L.lastIds = list.map(function (x) { return x.id; });
      try { L.next(L.docPath ? docSnap(L.docId, (list[0] || {}).data, pw) : querySnap(list, prev, pw)); }
      catch (e) { setTimeout(function () { throw e; }); }
    });
  }

  function refresh(name) { // サーバーから読み直す（同時に1本だけ）
    var c = C(name);
    if (c.busy) return c.busy;
    c.busy = call("GET", API + "/docs?c=" + encodeURIComponent(name) + (c.etag ? "&etag=" + c.etag : ""))
      .then(function (j) {
        if (!j.same) { var m = {}; (j.docs || []).forEach(function (d) { m[d.id] = d.data; }); c.server = m; }
        c.etag = j.etag; c.loaded = true; notify(name);
      })
      .finally(function () { c.busy = null; });
    return c.busy;
  }
  function schedule(name) {
    var c = C(name); clearTimeout(c.timer);
    if (!c.listeners.length) return;
    c.timer = setTimeout(function () {
      refresh(name).catch(function () {}).then(function () { schedule(name); });
    }, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    Object.keys(cols).forEach(function (n) { if (cols[n].listeners.length) { refresh(n).catch(function () {}); schedule(n); } });
  });

  function subscribe(name, q, next, error, docPath, docId) {
    var c = C(name), L = {q: q, next: next, error: error, lastKey: null, lastIds: null, docPath: docPath, docId: docId};
    c.listeners.push(L);
    // 最初の1回（アーティファクトと同じく、登録したすぐあとに今の中身を渡す）
    Promise.resolve().then(function () {
      if (c.listeners.indexOf(L) < 0) return;
      if (c.loaded) notify(name);
      refresh(name).catch(function () {}).then(function () { schedule(name); });
    });
    return function () {
      var i = c.listeners.indexOf(L); if (i >= 0) c.listeners.splice(i, 1);
      if (!c.listeners.length) clearTimeout(c.timer);
    };
  }

  function write(path, op, data) {
    var w = colOf(path), e = {op: op, data: clone(data)};
    (pend[path] = pend[path] || []).push(e);
    notify(w.col); // 保存が終わる前に画面へ反映
    var url = API + "/doc?p=" + encodeURIComponent(path);
    var method = op === "set" ? "PUT" : op === "update" ? "PATCH" : "DELETE";
    var run = (chains[path] || Promise.resolve()).catch(function () {}).then(function () {
      return call(method, url, op === "delete" ? {} : {data: data});
    });
    chains[path] = run;
    var drop = function () { var a = pend[path] || [], i = a.indexOf(e); if (i >= 0) a.splice(i, 1); if (!a.length) delete pend[path]; };
    return run.then(function () {
      return refresh(w.col).catch(function () {}).then(function () { drop(); notify(w.col); });
    }, function (err) { drop(); notify(w.col); throw err; });
  }

  // ---------------------------------------------------------------- db の形（アーティファクトと同じ）
  function makeQuery(name, q) {
    return {
      where: function (field, op, value) { return makeQuery(name, {filters: q.filters.concat([{field: field, op: op, value: value}]), order: q.order, lim: q.lim}); },
      orderBy: function (field, dir) { return makeQuery(name, {filters: q.filters, order: {field: field, dir: dir || "asc"}, lim: q.lim}); },
      limit: function (n) { return makeQuery(name, {filters: q.filters, order: q.order, lim: n}); },
      get: function () { return refresh(name).then(function () { return querySnap(applyQuery(q, view(name)), null, hasPending(name)); }); },
      onSnapshot: function (next, error) { return subscribe(name, q, next, error); }
    };
  }
  function docRef(path) {
    var s = segs(path, "doc"), w = colOf(path);
    return {
      id: s[s.length - 1], path: path,
      get: function () {
        return call("GET", API + "/doc?p=" + encodeURIComponent(path)).then(function (j) {
          var data = j.exists ? j.data : undefined;
          (pend[path] || []).forEach(function (e) {
            if (e.op === "set") data = clone(e.data); else if (e.op === "update") { if (data) data = deepMerge(data, e.data); } else data = undefined;
          });
          return docSnap(w.id, data, !!(pend[path] || []).length);
        });
      },
      set: function (data) { if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(dbErr("invalid_argument", "body must be an object")); return write(path, "set", data); },
      update: function (data) { if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(dbErr("invalid_argument", "body must be an object")); return write(path, "update", data); },
      delete: function () { return write(path, "delete"); },
      acquire: function () { return Promise.resolve({acquired: true, holder: "local"}); },
      onSnapshot: function (next, error) {
        return subscribe(w.col, {filters: [], order: null, lim: 0, only: w.id}, next, error, path, w.id);
      },
      collection: function (sub) { return colRef(path + "/" + sub); }
    };
  }
  function colRef(path) {
    segs(path, "col");
    var q = makeQuery(path, {filters: [], order: null, lim: 0});
    q.path = path;
    q.doc = function (id) { return docRef(path + "/" + (id || newId())); };
    q.add = function (data) { var r = docRef(path + "/" + newId()); return r.set(data).then(function () { return r; }); };
    return q;
  }
  var db = Object.freeze({
    doc: function (p) { return docRef(p); },
    collection: function (p) { return colRef(p); }
  });

  // ---------------------------------------------------------------- sample（Claude に聞く）
  function ask(input, opts, format) {
    return call("POST", "/api/sample", {input: input, opts: opts || {}, format: format}).then(function (j) { return j.data; });
  }
  var sample = Object.freeze({
    json: function (input, opts) { return ask(input, opts, "json"); },
    text: function (input, opts) { return ask(input, opts, "text"); }
  });

  // ---------------------------------------------------------------- window.claude
  var caps = {db: db, sample: BE && BE.noSample ? null : sample};
  var memo = {};
  window.claude = Object.freeze({
    use: function (name) {
      if (!memo[name]) memo[name] = new Promise(function (res) { setTimeout(function () { res(caps[name] || null); }, 0); });
      return memo[name];
    }
  });
})();
