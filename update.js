/* 🌸 BLOOM v5 スマホ版：新しい版があるかを見る（index.html が本体の頭に差し込む）
 *
 * スマホは控えの本体をすぐ出すので、/karada で作り直した新しい版は、ここで裏から取ってくる。
 * 開いたとき（3秒後）と、アプリに戻ってきたとき（前に見てから5分たっていれば）に page ブランチの印を見る。
 * 新しければ取ってきて控えを入れかえ、下に「新しいBLOOMがあります・切り替える」を出す（押すと読み直す）。
 * 2026/10/30〜 きのう劇場・みんなのトークの入口でも使う。どのファイルかは入口が window.BLOOM_PAGE_FILE に入れる。
 * page ブランチの印はどれか1つが変わっても変わるので、取ってきた中身が控えと同じなら知らせない（印だけ入れかえる）
 */
(function () {
  "use strict";
  var API = "https://api.github.com/repos/nekosan222/bloom-data";
  var TOKEN = (function () { try { return localStorage.getItem("bloomPhoneToken") || ""; } catch (e) { return ""; } })();
  var FILE = window.BLOOM_PAGE_FILE || "bloom5.html";
  var KEY = FILE === "bloom5.html" ? "page" : "page:" + FILE;
  var last = 0, busy = false, shown = false;
  if (!TOKEN) return;

  function headers(accept) { return {"Authorization": "Bearer " + TOKEN, "Accept": accept, "X-GitHub-Api-Version": "2022-11-28"}; }
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("bloom-phone", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(k) { return idb().then(function (d) { return new Promise(function (res) { var q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; }); }); }
  function idbPut(k, v) { return idb().then(function (d) { return new Promise(function (res) { var t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; }); }); }

  function banner() {
    if (shown) return; shown = true;
    var b = document.createElement("div");
    b.setAttribute("style", "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));" +
      "z-index:2147483647;background:#3A2533;color:#fff;border-radius:999px;padding:10px 12px 10px 18px;font:600 14px/1.2 system-ui,sans-serif;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;white-space:nowrap");
    b.innerHTML = (FILE === "bloom5.html" ? '🌸 新しいBLOOMがあります' : '🌸 新しい版があります') + '<button style="border:0;border-radius:999px;background:#E7798F;color:#fff;font:700 13px system-ui;padding:8px 12px">切り替える</button>';
    b.querySelector("button").onclick = function () { location.reload(); };
    document.body.appendChild(b);
  }

  function check() {
    if (busy || Date.now() - last < 5 * 60 * 1000) return;
    busy = true; last = Date.now();
    Promise.all([
      idbGet(KEY),
      fetch(API + "/commits/page", {headers: headers("application/vnd.github.sha"), cache: "no-store"}).then(function (r) { return r.ok ? r.text() : null; })
    ]).then(function (a) {
      var cached = a[0], sha = a[1] && a[1].trim();
      if (!sha || (cached && cached.sha === sha)) return;
      return fetch(API + "/contents/" + FILE + "?ref=page", {headers: headers("application/vnd.github.raw"), cache: "no-store"})
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (html) {
          var same = cached && cached.html === html;
          return idbPut(KEY, {sha: sha, html: html, at: Date.now()}).then(function () { if (!same) banner(); });
        });
    }).catch(function () {}).then(function () { busy = false; });
  }

  setTimeout(check, 3000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();
