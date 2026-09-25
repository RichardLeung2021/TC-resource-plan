/*
 * store.js - connects the resource plan page to its AWS backend.
 *
 * The page was written against a small document-store interface
 * (claude.use("db") / claude.use("downloads")). This file provides the same
 * interface on top of the REST API in /api, so the page itself is unchanged.
 *
 *   GET    /api/state              -> every document, plus a change version
 *   GET    /api/version            -> the current change version (cheap poll)
 *   PUT    /api/docs/{col}/{id}    -> create or replace a document
 *   DELETE /api/docs/{col}/{id}    -> delete a document
 *
 * Other people's changes are picked up by polling /api/version every few
 * seconds and reloading when it moves.
 */
(function () {
  'use strict';
  var API = (window.PLAN_API_BASE || '') + '/api';
  var POLL_MS = 5000;
  var PASS_KEY = 'lrp.passcode';
  var COLS = ['config', 'projects', 'people', 'resources'];

  var cache = {};             // col -> Map(id -> data)
  COLS.forEach(function (c) { cache[c] = new Map(); });
  var version = null;         // last server version seen
  var loaded = false;
  var pending = 0;            // writes in flight
  var colSubs = [];           // {col, next, error}
  var docSubs = [];           // {col, id, next, error}
  var loadPromise = null;

  function passcode() { try { return localStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; } }
  function setPasscode(v) { try { localStorage.setItem(PASS_KEY, v); } catch (e) {} }
  function err(code, message) { return { code: code, message: message }; }

  var asking = null;
  function askPasscode() {
    if (!asking) {
      asking = new Promise(function (resolve) {
        setTimeout(function () {
          var v = window.prompt('Enter the team passcode to open the resource plan.');
          asking = null;
          if (v) setPasscode(v.trim());
          resolve(!!v);
        }, 0);
      });
    }
    return asking;
  }

  async function call(method, path, body, retried) {
    var res;
    try {
      res = await fetch(API + path, {
        method: method,
        headers: Object.assign({ 'x-plan-passcode': passcode() }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
      });
    } catch (e) {
      throw err('unavailable', 'Network error');
    }
    if (res.status === 401) {
      if (!retried && await askPasscode()) return call(method, path, body, true);
      throw err('invalid_argument', 'Passcode required');
    }
    if (res.status === 413) throw err('invalid_argument', 'Document too large');
    if (res.status >= 500 || res.status === 429) throw err('unavailable', 'Server error ' + res.status);
    if (!res.ok) throw err('invalid_argument', 'Request rejected ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  function snapDoc(col, id) {
    var v = cache[col].get(id);
    return { id: id, exists: v !== undefined, data: function () { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }, metadata: { fromCache: false, hasPendingWrites: pending > 0 } };
  }
  function snapCol(col) {
    var docs = Array.from(cache[col].keys()).sort().map(function (id) { return snapDoc(col, id); });
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: pending > 0 } };
  }
  function notify(col) {
    colSubs.forEach(function (s) { if (s.col === col) s.next(snapCol(col)); });
    docSubs.forEach(function (s) { if (s.col === col) s.next(snapDoc(col, s.id)); });
  }
  function notifyAll() { COLS.forEach(notify); }
  function failAll(e) {
    colSubs.concat(docSubs).forEach(function (s) { if (s.error) s.error(e); });
  }

  async function load() {
    var data = await call('GET', '/state');
    COLS.forEach(function (c) {
      var m = new Map();
      (data.collections[c] || []).forEach(function (d) { m.set(d.id, d.data); });
      cache[c] = m;
    });
    version = data.version;
    loaded = true;
    notifyAll();
  }
  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = load().catch(function (e) { loadPromise = null; failAll(e); throw e; });
    }
    return loadPromise;
  }

  async function poll() {
    if (!loaded || pending > 0 || document.hidden) return;
    try {
      var v = await call('GET', '/version');
      if (v && v.version !== version && pending === 0) await load();
    } catch (e) { /* try again on the next tick */ }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  function checkPath(path, even) {
    var parts = String(path).split('/');
    if ((parts.length % 2 === 0) !== even) throw new TypeError('Bad path: ' + path);
    if (parts.length > 2) throw new TypeError('Nested paths are not supported: ' + path);
    if (COLS.indexOf(parts[0]) < 0) throw new TypeError('Unknown collection: ' + parts[0]);
    return parts;
  }
  function newId() {
    var a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.from(a, function (b) { return b.toString(36).padStart(2, '0'); }).join('').slice(0, 20);
  }

  function docRef(path) {
    var p = checkPath(path, true), col = p[0], id = p[1];
    async function write(method, body) {
      var before = cache[col].get(id);
      if (method === 'PUT') cache[col].set(id, JSON.parse(JSON.stringify(body)));
      else cache[col].delete(id);
      pending++;
      notify(col);
      try {
        var r = await call(method, '/docs/' + encodeURIComponent(col) + '/' + encodeURIComponent(id), body);
        if (r && typeof r.version === 'number') version = r.version;
      } catch (e) {
        if (before === undefined) cache[col].delete(id); else cache[col].set(id, before);
        notify(col);
        throw e;
      } finally {
        pending--;
      }
    }
    return {
      id: id, path: path,
      get: async function () { await ensureLoaded(); return snapDoc(col, id); },
      set: function (data) { return write('PUT', data); },
      update: async function (data) {
        var cur = cache[col].get(id);
        if (cur === undefined) throw err('invalid_argument', 'Document does not exist');
        return write('PUT', Object.assign({}, cur, data));
      },
      delete: function () { return write('DELETE'); },
      onSnapshot: function (next, error) {
        var s = { col: col, id: id, next: next, error: error };
        docSubs.push(s);
        if (loaded) setTimeout(function () { next(snapDoc(col, id)); }, 0); else ensureLoaded().catch(function () {});
        return function () { docSubs = docSubs.filter(function (x) { return x !== s; }); };
      }
    };
  }
  function colRef(path) {
    var col = checkPath(path, false)[0];
    return {
      path: path,
      doc: function (id) { return docRef(col + '/' + (id || newId())); },
      add: async function (data) { var r = docRef(col + '/' + newId()); await r.set(data); return r; },
      get: async function () { await ensureLoaded(); return snapCol(col); },
      onSnapshot: function (next, error) {
        var s = { col: col, next: next, error: error };
        colSubs.push(s);
        if (loaded) setTimeout(function () { next(snapCol(col)); }, 0); else ensureLoaded().catch(function () {});
        return function () { colSubs = colSubs.filter(function (x) { return x !== s; }); };
      }
    };
  }

  var db = Object.freeze({ doc: docRef, collection: colRef });

  var downloads = Object.freeze({
    save: async function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = req.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { status: 'saved' };
    }
  });

  window.claude = {
    use: async function (name) {
      if (name === 'db') return db;
      if (name === 'downloads') return downloads;
      return null;
    }
  };
})();
