/* Lagring. Två lägen med samma gränssnitt (all/get/put/del):
   - Lokalt: IndexedDB i webbläsaren. Kvitton med bilder, budgetplaner per månad och inställningar (konton, saldo, mål).
   - Moln: Supabase när man är inloggad. Tabellen kassakoll_items (en rad per post) och bucketen "kvitton" för bilder.
     Allt läses in en gång vid inloggning och hålls i minnet; ändringar skrivs direkt till Supabase. */
var DB = (function () {
  'use strict';

  var KEYS = { receipts: 'id', plans: 'month', settings: 'key' };

  /* ---------- Lokalt (IndexedDB) ---------- */

  var opened;

  function open() {
    if (opened) return opened;
    opened = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB saknas'));
      var req = indexedDB.open('kassakoll', 2);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('receipts')) d.createObjectStore('receipts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('plans')) d.createObjectStore('plans', { keyPath: 'month' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      // En annan flik med en äldre version håller databasen öppen
      req.onblocked = function () { opened = null; reject(new Error('blocked')); };
      req.onsuccess = function () {
        var d = req.result;
        d.onversionchange = function () { d.close(); };
        resolve(d);
      };
      req.onerror = function () { reject(req.error); };
    });
    return opened;
  }

  function run(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode);
        var out;
        var rq = fn(t.objectStore(store));
        if (rq) rq.onsuccess = function () { out = rq.result; };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  var local = {
    all: function (s) { return run(s, 'readonly', function (o) { return o.getAll(); }); },
    get: function (s, k) { return run(s, 'readonly', function (o) { return o.get(k); }); },
    put: function (s, v) { return run(s, 'readwrite', function (o) { return o.put(v); }); },
    del: function (s, k) { return run(s, 'readwrite', function (o) { return o.delete(k); }); }
  };

  /* ---------- Moln (Supabase) ---------- */

  var TABLE = 'kassakoll_items';
  var BUCKET = 'kvitton';
  var URL_TTL = 60 * 60 * 24 * 7;

  var client = null;
  var userId = null;
  var cache = { receipts: {}, plans: {}, settings: {} };
  var imagePaths = {}; // kvitto-id -> sökväg i bucketen

  // Kopior ut ur minnet, så att sidan inte ändrar i cachen innan något sparats (som IndexedDB)
  function copy(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function fail(res, what) {
    if (res.error) {
      var e = new Error(what + ': ' + (res.error.message || res.error));
      e.cloud = true;
      throw e;
    }
    return res.data;
  }

  async function loadAll() {
    cache = { receipts: {}, plans: {}, settings: {} };
    imagePaths = {};
    var rows = [];
    for (var from = 0; ; from += 1000) {
      var page = fail(await client.from(TABLE).select('store,key,data').range(from, from + 999), 'Kunde inte hämta data');
      rows = rows.concat(page);
      if (page.length < 1000) break;
    }
    var paths = [];
    rows.forEach(function (r) {
      if (!cache[r.store]) return;
      var v = r.data;
      if (r.store === 'receipts') {
        if (v.image_path) { imagePaths[v.id] = v.image_path; paths.push(v.image_path); }
        delete v.image_path;
        v.image = null;
      }
      cache[r.store][r.key] = v;
    });
    // Bilderna visas via tidsbegränsade länkar (bucketen är privat)
    if (paths.length) {
      var signed = fail(await client.storage.from(BUCKET).createSignedUrls(paths, URL_TTL), 'Kunde inte hämta bilder');
      var byPath = {};
      signed.forEach(function (s) { if (s.signedUrl) byPath[s.path] = s.signedUrl; });
      Object.keys(imagePaths).forEach(function (id) {
        if (cache.receipts[id]) cache.receipts[id].image = byPath[imagePaths[id]] || null;
      });
    }
    return rows.length;
  }

  var cloud = {
    all: async function (s) {
      return Object.keys(cache[s]).map(function (k) { return copy(cache[s][k]); });
    },
    get: async function (s, k) {
      return copy(cache[s][k]);
    },
    put: async function (s, v) {
      var key = String(v[KEYS[s]]);
      var data = Object.assign({}, v);
      var shown = null;
      if (s === 'receipts') {
        var img = v.image;
        delete data.image;
        var path = imagePaths[key] || null;
        if (img instanceof Blob) {
          path = userId + '/' + key + '.jpg';
          fail(await client.storage.from(BUCKET).upload(path, img, { upsert: true, contentType: img.type || 'image/jpeg' }), 'Kunde inte ladda upp bilden');
          shown = URL.createObjectURL(img);
        } else if (typeof img === 'string' && path) {
          shown = img; // oförändrad bild som redan finns i molnet
        } else if (path) {
          await client.storage.from(BUCKET).remove([path]);
          path = null;
        }
        data.image_path = path;
      }
      fail(await client.from(TABLE).upsert(
        { user_id: userId, store: s, key: key, data: copy(data), updated_at: new Date().toISOString() },
        { onConflict: 'user_id,store,key' }
      ), 'Kunde inte spara');
      if (s === 'receipts') {
        if (data.image_path) imagePaths[key] = data.image_path; else delete imagePaths[key];
        delete data.image_path;
        data.image = shown;
      }
      cache[s][key] = copy(data);
    },
    del: async function (s, k) {
      var key = String(k);
      fail(await client.from(TABLE).delete().eq('user_id', userId).eq('store', s).eq('key', key), 'Kunde inte ta bort');
      if (s === 'receipts' && imagePaths[key]) {
        await client.storage.from(BUCKET).remove([imagePaths[key]]);
        delete imagePaths[key];
      }
      delete cache[s][key];
    }
  };

  /* ---------- Gemensamt ---------- */

  var backend = local;

  return {
    all: function (s) { return backend.all(s); },
    get: function (s, k) { return backend.get(s, k); },
    put: function (s, v) { return backend.put(s, v); },
    del: function (s, k) { return backend.del(s, k); },
    local: local,
    isCloud: function () { return backend === cloud; },
    // Byt till molnet för en inloggad användare. Returnerar antal poster som fanns i molnet.
    useCloud: async function (supabaseClient, uid) {
      client = supabaseClient;
      userId = uid;
      var n = await loadAll();
      backend = cloud;
      return n;
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DB;
