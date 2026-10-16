/* 🌸 BLOOM v5 スマホ版：Mac のサーバーのかわりに、GitHub の非公開の置き場所（nekosan222/bloom-data）を読み書きする
 *
 * shim.js（Mac 版と同じファイル）より先に読み込む。window.BLOOM_BACKEND.call(method, url, body) が、
 * bloom_server.py の /api/db/… と同じ形の答えを返す。Mac が閉じていても、外出先でも動く。
 *   - 読む：棚のフォルダの一覧（contents API）を見て、中身は blob の sha ごとに読んで控える（同じ sha は読み直さない）
 *           一覧は ETag 付きで聞く（変わっていなければ 304 で、GitHub の回数制限にも数えられない）
 *   - 書く：bloom_server.py と同じ形のファイル（キーは名前順・__savedAt 付き・1字下げ）。Mac は30秒ごとの同期で取り込む
 *           ぶつかったら（sha が古い）読み直して3回までやり直す。Mac 側でぶつかったときは __savedAt の新しいほうが残る
 *   - 消す：ファイルを <棚>/_消したもの/<文書>_<時刻>.json に移してから消す（Mac と同じ）
 *   - 鍵（GitHub のトークン）は index.html が最初に1回だけ聞いて、このスマホのブラウザの中にだけ置く
 */
(function () {
  "use strict";
  var OWNER = "nekosan222", REPO = "bloom-data", BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var META = "__savedAt", DELETED = "_消したもの";
  var TOKEN = (function () { try { return localStorage.getItem("bloomPhoneToken") || ""; } catch (e) { return ""; } })();

  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; }
  function nowIso() { // Mac と同じ形：2026-10-16T09:12:34.567+09:00
    var d = new Date(), o = -d.getTimezoneOffset(), sg = o >= 0 ? "+" : "-"; o = Math.abs(o);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3) + sg + pad(Math.floor(o / 60)) + ":" + pad(o % 60);
  }
  function stamp() { return nowIso().replace(/[^0-9]/g, "").slice(0, 17); }
  function b64encode(text) {
    var bytes = new TextEncoder().encode(text), s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function dump(doc) { // bloom_server.py の dump_doc と同じ形
    var out = {};
    Object.keys(doc).sort().forEach(function (k) { out[k] = doc[k]; });
    return JSON.stringify(out, null, 1) + "\n";
  }
  function strip(doc) { var o = {}; Object.keys(doc || {}).forEach(function (k) { if (k !== META) o[k] = doc[k]; }); return o; }
  function deepMerge(base, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) deepMerge(base[k], v);
      else base[k] = v;
    });
    return base;
  }
  function filePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

  function gh(method, path, body, extra) {
    var h = {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"};
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    var opt = {method: method, headers: h, cache: "no-store"};
    if (body) { h["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(API + path, opt).catch(function () { throw err("unavailable", "GitHub につながりません（電波を確かめてください）"); });
  }
  function fail(r, what) {
    return r.text().then(function (t) {
      var m = ""; try { m = JSON.parse(t).message || ""; } catch (e) { m = t.slice(0, 120); }
      if (r.status === 401) throw err("permission_denied", "鍵（トークン）が使えません。アドレスの後ろに ?setup を付けて入れ直してください");
      if (r.status === 403 && /rate limit/i.test(m)) throw err("resource_exhausted", "GitHub の回数制限に当たりました。少し待ってください");
      throw err("unavailable", what + "に失敗（" + r.status + " " + m + "）");
    });
  }

  // ---------------------------------------------------------------- 読む
  var listCache = {};   // 棚 → {etag, files: [{name, sha}]}
  var blobCache = {};   // sha → 中身（{…}）
  function readBlob(sha) {
    if (blobCache[sha]) return Promise.resolve(blobCache[sha]);
    return gh("GET", "/git/blobs/" + sha).then(function (r) {
      if (!r.ok) return fail(r, "読み込み");
      return r.json().then(function (j) {
        var d = null; try { d = JSON.parse(b64decode(j.content)); } catch (e) { d = null; }
        if (d && typeof d === "object" && !Array.isArray(d)) blobCache[sha] = d;
        return blobCache[sha] || null;
      });
    });
  }
  function listCol(col) {
    var c = listCache[col], extra = c && c.etag ? {"If-None-Match": c.etag} : {};
    return gh("GET", "/contents/" + filePath(col) + "?ref=" + BRANCH, null, extra).then(function (r) {
      if (r.status === 304 && c) return c.files;
      if (r.status === 404) { listCache[col] = {etag: null, files: []}; return []; }
      if (!r.ok) return fail(r, "一覧の読み込み");
      return r.json().then(function (arr) {
        var files = (Array.isArray(arr) ? arr : []).filter(function (f) {
          return f.type === "file" && /\.json$/.test(f.name) && !/^[._]/.test(f.name);
        }).map(function (f) { return {name: f.name.slice(0, -5), sha: f.sha}; });
        listCache[col] = {etag: r.headers.get("ETag"), files: files};
        return files;
      });
    });
  }
  function docs(col) {
    return listCol(col).then(function (files) {
      var etag = files.map(function (f) { return f.name + ":" + f.sha; }).join("|");
      return Promise.all(files.map(function (f) {
        return readBlob(f.sha).then(function (d) { return d ? {id: f.name, data: strip(d)} : null; });
      })).then(function (list) { return {etag: etag, docs: list.filter(Boolean)}; });
    });
  }
  function getFile(path) { // → {exists, sha, data}
    return gh("GET", "/contents/" + filePath(path) + ".json?ref=" + BRANCH).then(function (r) {
      if (r.status === 404) return {exists: false, sha: null, data: null};
      if (!r.ok) return fail(r, "読み込み");
      return r.json().then(function (j) {
        var d = null; try { d = JSON.parse(b64decode(j.content)); } catch (e) { d = null; }
        return {exists: !!d, sha: j.sha, data: d};
      });
    });
  }

  // ---------------------------------------------------------------- 書く
  function putFile(path, doc, sha, msg) {
    var body = {message: msg, content: b64encode(dump(doc)), branch: BRANCH};
    if (sha) body.sha = sha;
    return gh("PUT", "/contents/" + filePath(path) + ".json", body);
  }
  function retry(fn) { // sha が古い（相手が先に書いた）ときは読み直してやり直す
    var n = 0;
    function go() {
      return fn().then(function (r) {
        if ((r.status === 409 || r.status === 422) && n++ < 3) return go();
        if (!r.ok) return fail(r, "保存");
        return r.json().catch(function () { return {}; });
      });
    }
    return go();
  }
  function setDoc(path, data) {
    var doc = strip(data); doc[META] = nowIso();
    return retry(function () {
      return getFile(path).then(function (f) { return putFile(path, doc, f.sha, "更新 " + path + "（スマホ）"); });
    }).then(function () { return {ok: true, data: strip(doc)}; });
  }
  function updateDoc(path, data) {
    var out = null;
    return retry(function () {
      return getFile(path).then(function (f) {
        if (!f.exists) throw err("not_found", "その文書はありません");
        out = deepMerge(f.data, strip(data)); out[META] = nowIso();
        return putFile(path, out, f.sha, "更新 " + path + "（スマホ）");
      });
    }).then(function () { return {ok: true, data: strip(out)}; });
  }
  function deleteDoc(path) {
    return getFile(path).then(function (f) {
      if (!f.exists) return {ok: true, data: null};
      var s = path.split("/"), id = s.pop(), keep = s.concat([DELETED, id + "_" + stamp()]).join("/");
      return putFile(keep, f.data, null, "消した（控えに移した） " + path + "（スマホ）").then(function (r) {
        if (!r.ok) return fail(r, "控えへの移動");
        return gh("DELETE", "/contents/" + filePath(path) + ".json",
                  {message: "消した " + path + "（スマホ）", sha: f.sha, branch: BRANCH}).then(function (r2) {
          if (!r2.ok && r2.status !== 404) return fail(r2, "消す");
          return {ok: true, data: null};
        });
      });
    });
  }

  // ---------------------------------------------------------------- bloom_server.py と同じ形の入口
  function call(method, url, body) {
    if (!TOKEN) return Promise.reject(err("permission_denied", "鍵（トークン）がまだありません"));
    var u = new URL(url, location.href), q = u.searchParams;
    if (u.pathname === "/api/db/docs" && method === "GET") {
      return docs(q.get("c") || "").then(function (j) { return q.get("etag") === j.etag ? {etag: j.etag, same: true} : j; });
    }
    if (u.pathname === "/api/db/doc") {
      var p = q.get("p") || "";
      if (method === "GET") return getFile(p).then(function (f) { return {exists: f.exists, data: f.exists ? strip(f.data) : null}; });
      if (method === "PUT") return setDoc(p, (body || {}).data || {});
      if (method === "PATCH") return updateDoc(p, (body || {}).data || {});
      if (method === "DELETE") return deleteDoc(p);
    }
    return Promise.reject(err("unavailable", "スマホ版では使えません"));
  }

  window.BLOOM_BACKEND = {call: call, pollMs: 15000, pollHiddenMs: 60000, noSample: true};
})();
