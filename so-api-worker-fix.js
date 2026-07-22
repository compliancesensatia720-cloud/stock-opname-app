/**
 * ============================================================
 *  SO-API — Cloudflare Workers  (VERSI SPLIT STORAGE: KV + R2)
 *  URL: https://so-api.sensatia.workers.dev/
 *
 *  ⚠️ PERUBAHAN DI FILE INI dibanding versi sebelumnya (archive fix):
 *   - Ditambahkan `case 'archive'`   → sebelumnya TIDAK ADA di worker,
 *     padahal frontend (finalizeSesiCloud) sudah memanggilnya sejak lama.
 *     Akibatnya snapshot final SELALU gagal disimpan diam-diam
 *     (frontend cuma console.warn + toast "gagal" lalu lanjut finalisasi).
 *   - Ditambahkan `case 'getArchive'` → untuk membaca snapshot tsb nanti
 *     (belum dipakai UI, tapi disiapkan agar simetris dengan archive).
 *   - `delete` TIDAK menghapus archive/{kode}.json — snapshot final
 *     dianggap catatan permanen, sama seperti CSVStockwiz yang juga
 *     tidak dihapus saat sesi dihapus. Ubah bagian ini kalau mau
 *     archive ikut terhapus saat sesi dihapus.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 2 — persiapan skala 50 toko):
 *   1) HAPUS index:sesi (shared mutable array di KV).
 *      Sebelumnya `create`/`delete` melakukan read-modify-write
 *      (getIndex → ubah array → put balik SELURUH array) tanpa lock apa
 *      pun. Kalau 2 toko create/delete nyaris bersamaan, salah satu
 *      overwrite yang lain → sesi "hilang" dari `list` (datanya sendiri
 *      di KV/R2 tetap ada, cuma nggak nongol). Ini enteng waktu toko
 *      masih sedikit, tapi peluang tabrakannya naik seiring jumlah toko.
 *      Sekarang `list` pakai kv.list({prefix:'meta:'}) — enumerasi key
 *      langsung dari KV, tiap create/delete cuma nyentuh key miliknya
 *      sendiri, jadi nggak ada shared state yang bisa saling timpa.
 *      Konsekuensi: KV list() itu eventually-consistent (bisa telat
 *      sampai ~60 detik utk propagasi), jadi sesi yang BARU dibuat bisa
 *      butuh beberapa saat sebelum muncul di `list` — tapi ini jauh
 *      lebih aman daripada risiko kehilangan entri index permanen.
 *   2) LOCK sesi yang sudah 'final'. `updateStock`, `updateCSV`,
 *      `updateExpired`, `updateMeta` sekarang cek meta.status dulu —
 *      kalau sudah 'final', request ditolak (409) alih-alih diam-diam
 *      diterima. Ini jaring pengaman kedua di level API (selain apa pun
 *      yang sudah dicegah di frontend), supaya device yang telat sync
 *      atau bug di frontend nggak bisa diam-diam mengubah data sesi
 *      yang sudah difinalisasi untuk keperluan audit.
 *      `finalize` SENGAJA TIDAK dikunci serupa (re-finalize sesi yang
 *      sudah final tetap diizinkan) — supaya sesi final versi lama
 *      (dari sebelum fix archive di atas) masih bisa di-finalize ulang
 *      untuk backfill snapshot archive-nya.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 3 — SUPERCREATOR):
 *   3) Nama di SUPERCREATOR_NAMES di bawah BOLEH melewati lock final di
 *      atas (dipakai untuk koreksi darurat pasca-finalisasi). Setiap kali
 *      dipakai, override-nya DICATAT PERMANEN ke meta.finalOverrideLog
 *      (siapa, kapan, action apa) — SATU-SATUNYA jejak bahwa data final
 *      sempat diubah lagi setelah dikunci. Jangan hapus logic pencatatan
 *      ini walau mau ganti daftar nama.
 *      ⚠️ CATATAN KEAMANAN: worker ini tidak punya autentikasi apa pun
 *      (tidak ada password/token per request) — actorNama dikirim mentah
 *      dari client dan TIDAK diverifikasi. Bypass ini SEPENUHNYA berbasis
 *      kecocokan nama, sama seperti seluruh model kepercayaan aplikasi ini
 *      (role Creator/Joiner juga self-declared). Siapa pun yang tahu nama
 *      di daftar ini bisa mengetik nama yang sama dan mendapat privilese
 *      yang sama. Kalau butuh jaminan lebih kuat, ini perlu diganti
 *      dengan autentikasi beneran (mis. shared-secret header per user),
 *      bukan sekadar cocok nama.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 4 — FIX SESI FINAL JADI KOSONG/TERTIMPA):
 *   4) `create` sekarang cek dulu apakah `kode` yang diminta sudah ada.
 *      Sebelumnya `create` LANGSUNG overwrite meta + reset stock ke []
 *      tanpa peduli apakah kode itu sudah dipakai sesi lain — baik yang
 *      masih aktif maupun yang sudah final/final2. Kalau create terpanggil
 *      dua kali dengan kode yang sama (retry, bug frontend, atau kode
 *      collision antar toko), efeknya: sesi yang sudah ada (termasuk yang
 *      sudah final) ke-reset jadi status 'aktif' lagi dan stock-nya
 *      ditimpa jadi kosong. Sekarang: kalau kode sudah dipakai sesi
 *      final/final2 → ditolak (409). Kalau masih aktif → TIDAK di-reset,
 *      kembalikan saja data sesi yang sudah ada (idempotent).
 *   5) `updateExpired` sekarang konsisten dengan updateStock/updateCSV:
 *      cek dulu sesi (`meta:{kode}`) benar-benar ada sebelum menulis,
 *      supaya tidak membuat entri expired "yatim" untuk kode yang sesinya
 *      tidak pernah ada / sudah dihapus.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 5 — WORKFLOW PHASE TIDAK PERNAH SAMPAI KE CLOUD):
 *   6) `updateMeta` sekarang menerima field `workflowPhase`
 *      ('input'|'val1'|'val2'|'done'). Sebelumnya field ini TIDAK ADA di
 *      whitelist `allowed`, padahal frontend sudah lama menyimpan
 *      workflowPhase secara lokal (localStorage) untuk tiap sesi — hasilnya
 *      meta di KV tidak pernah punya field ini sama sekali, jadi device
 *      lain / dashboard yang baca sesi ini lewat `get` selalu mengira
 *      sesi masih di tahap 'input' walau sebenarnya sudah di Validasi 1/2
 *      atau sudah Selesai. Nilai di luar 4 pilihan yang dikenal akan
 *      dibuang (bukan disimpan) supaya tidak ada data sampah di KV.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 6 — FIX finalOverrideLog BISA HILANG):
 *   7) BUG: saat supercreator bypass lock-final (LOCKED_AFTER_FINAL), guard
 *      menulis `metaCheck` (berisi finalOverrideLog baru) ke KV, lalu
 *      handler action (updateStock/updateCSV/updateMeta) MEMBACA ULANG
 *      meta dari KV secara terpisah dan menulis balik versi itu. Karena KV
 *      eventually-consistent, get() kedua ini TIDAK dijamin melihat put()
 *      pertama — kalau masih lihat versi lama, put() kedua akan MENIMPA
 *      dan MENGHILANGKAN finalOverrideLog yang baru saja dicatat. Padahal
 *      field ini SATU-SATUNYA jejak audit bahwa data final diubah lagi.
 *      FIX: guard sekarang menitipkan objek meta yang SUDAH di-update
 *      (termasuk finalOverrideLog) lewat `data._metaCache`, dan handler
 *      updateMeta/updateStock/updateCSV memakai `data._metaCache` itu
 *      kalau tersedia, alih-alih get() ulang dari KV. Ini menghilangkan
 *      race read-modify-write ganda dalam satu request yang sama.
 *
 *  ⚠️ PERUBAHAN DI FILE INI (round 7 — FIX RACE CONDITION 'BATAL FINAL'):
 *   8) Memindahkan pengambilan KV `meta` di `updateStock` & `updateCSV`
 *      ke SETELAH proses upload R2 selesai. R2 upload butuh waktu lama (bisa detik).
 *      Jika `meta` diambil sebelum R2 jalan, maka kalau di detik yang sama
 *      user menekan "Finalisasi", status 'final' akan langsung tertimpa (overwrite)
 *      kembali jadi 'aktif' oleh proses sync stock ini (karena memori cache-nya basi).
 * ============================================================
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Actions yang mengubah data substantif sebuah sesi — diblokir kalau
// sesi tsb sudah berstatus 'final'. (finalize/archive/getArchive/delete
// sengaja TIDAK termasuk di sini — lihat catatan di header file.)
const LOCKED_AFTER_FINAL = new Set(['updateStock', 'updateCSV', 'updateExpired', 'updateMeta']);

// Nama-nama yang boleh melewati lock final di atas. HARUS sama persis
// dengan SUPERCREATOR_NAMES di frontend (stock-opname.html) — kalau beda,
// frontend & backend bisa saling tidak sinkron (mis. UI kebuka tapi
// request tetap ditolak worker, atau sebaliknya).
const SUPERCREATOR_NAMES = new Set(['YASA KARYADA']);
function isSuperCreator(nama, role) {
  return role === 'admin' && SUPERCREATOR_NAMES.has((nama || '').trim().toUpperCase());
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return jsonResp({ ok: false, error: 'Method not allowed' }, 405);
    }

    let payload;
    try {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const raw = params.get('payload');
      if (!raw) throw new Error('Missing payload');
      payload = JSON.parse(raw);
    } catch (e) {
      return jsonResp({ ok: false, error: 'Invalid payload: ' + e.message }, 400);
    }

    const { action, ...data } = payload;
    const kv = env.SO_KV || env.KV;
    const r2 = env.SO_R2 || env.R2;

    if (!kv) {
      return jsonResp({ ok: false, error: 'KV Namespace tidak ditemukan. Pastikan sudah di-bind sebagai SO_KV atau KV di Cloudflare Dashboard.' }, 500);
    }

    try {
      // ── Guard: kunci sesi yang sudah final untuk action tertentu ──
      // (kecuali actor tercatat sebagai SUPERCREATOR, dan HANYA untuk status
      // 'final' tahap 1 — status 'final2' mengunci SIAPA PUN tanpa kecuali)
      if (LOCKED_AFTER_FINAL.has(action)) {
        const { kode } = data;
        if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);
        const metaCheck = await kv.get(`meta:${kode}`, 'json');
        if (!metaCheck) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

        if (metaCheck.status === 'final2') {
          // Terkunci PERMANEN — tidak ada bypass apa pun di sini, termasuk
          // untuk nama-nama di SUPERCREATOR_NAMES.
          return jsonResp({
            ok: false,
            error: 'Sesi ini sudah Finalisasi 2 (terkunci permanen) dan tidak bisa diubah oleh siapa pun.',
          }, 409);
        }

        if (metaCheck.status === 'final') {
          const actor = data.actorNama || data.updatedBy || data.finalizedBy || '';
          const role = data.actorRole || '';
          if (isSuperCreator(actor, role)) {
            // ── BYPASS: catat override ke log permanen di meta sebelum
            // lanjut ke handler asli. Ini SATU-SATUNYA jejak audit bahwa
            // sesi final ini diubah lagi setelah dikunci — jangan dihapus.
            const logEntry = {
              action,
              by: actor,
              at: new Date().toISOString(),
            };
            metaCheck.finalOverrideLog = Array.isArray(metaCheck.finalOverrideLog)
              ? [...metaCheck.finalOverrideLog, logEntry]
              : [logEntry];
            await kv.put(`meta:${kode}`, JSON.stringify(metaCheck));

            // ── FIX (round 6) ──────────────────────────────────────────
            // Titipkan meta yang SUDAH mengandung finalOverrideLog ini ke
            // handler di bawah lewat `data._metaCache`, supaya handler
            // TIDAK perlu get() ulang dari KV (yang eventually-consistent
            // dan bisa saja masih mengembalikan versi lama tanpa log ini).
            // Kalau handler tetap get() ulang lalu put() balik versi lama,
            // finalOverrideLog yang baru saja ditulis di atas akan hilang
            // tertimpa — itulah bug yang diperbaiki di sini.
            data._metaCache = metaCheck;
            // Lanjut ke switch(action) di bawah seperti biasa (tidak di-block)
          } else {
            return jsonResp({
              ok: false,
              error: 'Sesi ini sudah berstatus final dan tidak bisa diubah lagi.',
            }, 409);
          }
        }
      }

      switch (action) {

        case 'create': {
          const kode = data.kode || generateKode();

          // ── GUARD BARU (round 4) ───────────────────────────────────
          // Cegah create() menimpa sesi yang sudah ada di kode ini.
          // Root cause bug "sesi final jadi kosong / tertimpa data toko
          // lain": sebelumnya create() langsung overwrite meta + reset
          // stock ke [] tanpa cek apakah kode ini sudah dipakai sesi lain
          // (final ataupun masih aktif).
          const existing = await kv.get(`meta:${kode}`, 'json');
          if (existing) {
            if (existing.status === 'final' || existing.status === 'final2') {
              return jsonResp({
                ok: false,
                error: `Kode ${kode} sudah dipakai sesi yang sudah difinalisasi` +
                  (existing.unit ? ` (${existing.unit})` : '') +
                  '. Tidak bisa dibuat ulang — pakai kode lain.',
              }, 409);
            }
            // Sesi dengan kode ini sudah ada dan masih aktif — JANGAN reset
            // datanya (stock/csv/expired berpotensi hilang kalau di-reset).
            // Kembalikan saja sesi yang sudah ada (idempotent).
            return jsonResp({ ok: true, kode, data: existing, resumed: true });
          }

          const now = new Date().toISOString();
          const meta = {
            kode,
            unit:       data.unit       || '',
            tanggal:    data.tanggal    || '',
            pukulStart: data.pukulStart || '',
            pukulEnd:   data.pukulEnd   || '',
            pukulZone:  data.pukulZone  || 'WITA',
            petugas:    Array.isArray(data.petugas) ? data.petugas : [],
            status:     'aktif',
            createdAt:  now,
            updatedAt:  now,
            productCount: 0,
            csvRowCount:  0,
          };

          await kv.put(`meta:${kode}`, JSON.stringify(meta));
          await putStock(r2, kv, kode, []);
          await putExpired(r2, kv, kode, { expireds: [], updatedBy: '' });

          // (Tidak ada lagi addToIndex — lihat catatan index:sesi di header file)

          return jsonResp({ ok: true, kode, data: meta });
        }

        case 'list': {
          // Enumerasi langsung dari KV (prefix 'meta:') — tidak lagi
          // bergantung pada shared index:sesi yang rawan race condition.
          const kodes = await listMetaKodes(kv);
          const limit = Number.isFinite(data.limit) && data.limit > 0
            ? Math.floor(data.limit)
            : null;

          const metas = await Promise.all(
            kodes.map(k => kv.get(`meta:${k}`, 'json'))
          );
          const list = metas
            .filter(Boolean)
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          const sliced = limit ? list.slice(0, limit) : list;

          return jsonResp({ ok: true, data: sliced, total: list.length });
        }

        case 'get':
        case 'join': {
          const { kode, includeCsv } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const meta = await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          const products = await getStock(r2, kv, kode);

          const resp = { ...meta, products };

          if (includeCsv) {
            const csvData = await getCsv(r2, kv, kode);
            if (csvData) {
              resp.csvRows     = csvData.csvRows     || [];
              resp.csvFilename = csvData.csvFilename || '';
            }
          }

          return jsonResp({ ok: true, data: resp });
        }

        case 'getMeta': {
          const { kode } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const meta = await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          return jsonResp({ ok: true, data: meta });
        }

        case 'updateMeta': {
          const { kode, ...fields } = data;
          // (kode required + sesi ada + belum final sudah dicek di guard atas)
          // ── FIX (round 6): pakai meta yang dititipkan guard (kalau ada)
          // supaya finalOverrideLog yang baru ditulis tidak hilang tertimpa
          // oleh get() ulang yang eventually-consistent. Field internal
          // `_metaCache` dibuang dari `fields` di bawah supaya tidak ikut
          // dianggap field meta biasa (lihat filter `allowed`).
          delete fields._metaCache;
          const meta = data._metaCache || await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          const allowed = [
            'unit', 'tanggal', 'pukulStart', 'pukulEnd', 'pukulZone',
            'petugas', 'resetAt', 'csvFilename',
            // workflowPhase ('input'|'val1'|'val2'|'done') — ditambahkan (round 5)
            // supaya dashboard (tab "Sesi Aktif") bisa tahu tahap validasi sesi
            // yang sedang berjalan tanpa membuka sesi tsb. Sebelumnya field ini
            // hanya tersimpan di localStorage device masing-masing dan TIDAK
            // PERNAH sampai ke worker — jadi dashboard selalu melihat tahap
            // 'input' walau sesi sebenarnya sudah di Validasi 1/2.
            'workflowPhase',
          ];
          for (const f of allowed) {
            if (fields[f] !== undefined) meta[f] = fields[f];
          }
          // Validasi workflowPhase — kalau device pengirim kirim nilai di luar
          // daftar yang dikenal (bug/versi lama), jangan simpan nilai sampah.
          if (meta.workflowPhase !== undefined &&
              !['input', 'val1', 'val2', 'done'].includes(meta.workflowPhase)) {
            delete meta.workflowPhase;
          }
          meta.updatedAt = new Date().toISOString();

          await kv.put(`meta:${kode}`, JSON.stringify(meta));
          return jsonResp({ ok: true, data: meta });
        }

        case 'updateStock': {
          const { kode, products, updatedBy } = data;
          const incomingProds = Array.isArray(products) ? products : [];

          try {
            // 1. Ambil data stok yang ada saat ini dari R2
            let currentProds = await getStock(r2, kv, kode);
            if (!Array.isArray(currentProds)) currentProds = [];

            const currentMap = new Map();
            for (const p of currentProds) {
              if (p && p.sku) currentMap.set(p.sku, p);
            }

            let mergedCount = 0;
            // 2. Gabungkan data baru (Last Edit Wins via _updatedAt)
            for (const p of incomingProds) {
              if (!p || !p.sku) continue;
              const old = currentMap.get(p.sku);
              const pTime = p._updatedAt || 0;
              const oldTime = old ? (old._updatedAt || 0) : 0;
              
              // Jika data baru lebih mutakhir (atau sama), timpa/hapus data lama
              if (!old || pTime >= oldTime) {
                if (p._deleted) {
                  currentMap.delete(p.sku);
                } else {
                  currentMap.set(p.sku, p);
                }
                mergedCount++;
              }
            }

            const finalProds = Array.from(currentMap.values());

            // 3. Simpan hasil gabungan ke R2
            await putStock(r2, kv, kode, finalProds);

            // 4. Update Meta (HANYA JIKA JUMLAH PRODUK BERUBAH)
            // Ini untuk menghemat kuota KV put() yang sangat terbatas (1000/hari di free tier).
            // Kalau cuma edit QTY, tidak perlu update meta di KV terus-menerus.
            const meta = data._metaCache || await kv.get(`meta:${kode}`, 'json');
            if (meta) {
              if (meta.productCount !== finalProds.length) {
                meta.updatedAt    = new Date().toISOString();
                meta.productCount = finalProds.length;
                if (updatedBy) meta.lastUpdatedBy = updatedBy;
                await kv.put(`meta:${kode}`, JSON.stringify(meta));
              }
            }

            return jsonResp({ ok: true, count: finalProds.length, merged: mergedCount });
          } catch(err) {
            return jsonResp({ ok: false, error: err.message }, 500);
          }
        }

        case 'updateCSV': {
          const { kode, csvRows, csvFilename } = data;
          // (kode required + sesi ada + belum final sudah dicek di guard atas)
          
          const rows = Array.isArray(csvRows) ? csvRows : [];
          
          // 1. Lakukan operasi I/O lambat (upload ke R2) TERLEBIH DAHULU
          await putCsv(r2, kv, kode, { csvFilename: csvFilename || '', csvRows: rows });

          // 2. BARU baca meta dari KV sesudah upload selesai.
          const meta = data._metaCache || await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          if (csvFilename) meta.csvFilename = csvFilename;
          meta.csvRowCount = rows.length;
          meta.updatedAt   = new Date().toISOString();
          await kv.put(`meta:${kode}`, JSON.stringify(meta));

          return jsonResp({ ok: true, count: rows.length });
        }

        case 'updateExpired': {
          const { kode, expireds, updatedBy } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);
          // (round 4) — konsistenkan dengan updateStock/updateCSV: cek dulu
          // sesi benar-benar ada sebelum menulis expired, supaya tidak
          // membuat entri "yatim" untuk kode yang sesinya tidak pernah ada
          // / sudah dihapus. (belum-final sudah dicek di guard atas.)
          // Catatan: action ini TIDAK menulis ulang meta:{kode}, jadi tidak
          // terpengaruh oleh fix finalOverrideLog (round 6) — cukup pakai
          // _metaCache kalau tersedia supaya tidak double-fetch, tapi boleh
          // juga tetap get() biasa karena tidak ada risiko timpa-menimpa.
          const metaExists = data._metaCache || await kv.get(`meta:${kode}`, 'json');
          if (!metaExists) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          const rows = Array.isArray(expireds) ? expireds : [];
          await putExpired(r2, kv, kode, {
            expireds:  rows,
            updatedBy: updatedBy || '',
            updatedAt: new Date().toISOString(),
          });

          return jsonResp({ ok: true, count: rows.length });
        }

        case 'getExpired': {
          const { kode } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const raw = await getExpired(r2, kv, kode);
          return jsonResp({ ok: true, data: raw || { expireds: [] } });
        }

        case 'finalize': {
          const { kode, finalizedBy, currentStock, currentExpired } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const meta = await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          if (meta.status === 'final2') {
            return jsonResp({ ok: false, error: 'Sesi sudah Finalisasi 2 (terkunci permanen).' }, 409);
          }

          const now = new Date().toISOString();
          meta.status      = 'final';
          meta.finalizedBy = finalizedBy || '';
          meta.finalizedAt = now;
          meta.updatedAt   = now;

          // Atomic 1-step backend orchestration
          const promises = [];
          if (Array.isArray(currentStock)) promises.push(putStock(r2, kv, kode, currentStock));
          if (Array.isArray(currentExpired)) {
            promises.push(putExpired(r2, kv, kode, { expireds: currentExpired, updatedBy: finalizedBy || '', updatedAt: now }));
          }

          const archivePayload = {
            ...meta,
            products: Array.isArray(currentStock) ? currentStock : [],
            archivedAt: now
          };
          if (r2) {
            promises.push(r2.put(`archive/${kode}.json`, JSON.stringify(archivePayload), {
              httpMetadata: { contentType: 'application/json' }
            }));
          } else {
            promises.push(kv.put(`archive:${kode}`, JSON.stringify(archivePayload)));
          }

          promises.push(kv.put(`meta:${kode}`, JSON.stringify(meta)));

          await Promise.all(promises);

          return jsonResp({ ok: true, data: meta });
        }

        // ── FINALIZE 2 ────────────────────────────────────────────
        // Kunci PERMANEN — tidak ada bypass apa pun setelah ini, termasuk
        // untuk SUPERCREATOR_NAMES (lihat guard LOCKED_AFTER_FINAL di atas,
        // status 'final2' selalu ditolak tanpa tanpa kecuali). Cuma bisa dipicu
        // oleh nama yang terdaftar sebagai supercreator, dan sesi harus
        // sudah lolos 'finalize' (tahap 1) dulu.
        case 'finalize2': {
          const { kode, finalized2By, currentStock, currentExpired } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const actor = data.actorNama || finalized2By || '';
          const role = data.actorRole || '';
          if (!isSuperCreator(actor, role)) {
            return jsonResp({ ok: false, error: 'Hanya supercreator yang dapat melakukan Finalisasi 2.' }, 403);
          }

          const meta = await kv.get(`meta:${kode}`, 'json');
          if (!meta) return jsonResp({ ok: false, error: 'Sesi tidak ditemukan' }, 404);

          if (meta.status === 'final2') {
            return jsonResp({ ok: true, data: meta }); // idempotent — sudah final2, no-op
          }
          if (meta.status !== 'final') {
            return jsonResp({ ok: false, error: 'Sesi harus melalui Finalisasi 1 dulu sebelum Finalisasi 2.' }, 409);
          }

          const now = new Date().toISOString();
          meta.status        = 'final2';
          meta.finalized2By  = finalized2By || actor;
          meta.finalized2At  = now;
          meta.updatedAt     = now;

          // Atomic 1-step backend orchestration
          const promises = [];
          if (Array.isArray(currentStock)) promises.push(putStock(r2, kv, kode, currentStock));
          if (Array.isArray(currentExpired)) {
            promises.push(putExpired(r2, kv, kode, { expireds: currentExpired, updatedBy: actor, updatedAt: now }));
          }
          promises.push(kv.put(`meta:${kode}`, JSON.stringify(meta)));
          
          await Promise.all(promises);

          return jsonResp({ ok: true, data: meta });
        }

        // ── ARCHIVE ─────────────────────────────────────────────
        // Snapshot immutable (meta + products) saat finalisasi.
        // Disimpan di R2 karena ukurannya sama besar dengan stock/csv,
        // dan cuma ditulis SEKALI per sesi (saat finalize) — bukan tiap sync.
        case 'archive': {
          const { kode, data: archivePayload } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);
          if (!archivePayload) return jsonResp({ ok: false, error: 'data required' }, 400);

          const payloadToSave = JSON.stringify({
            ...archivePayload,
            archivedAt: new Date().toISOString(),
          });
          if (r2) {
            await r2.put(`archive/${kode}.json`, payloadToSave, { httpMetadata: { contentType: 'application/json' } });
          } else {
            await kv.put(`archive:${kode}`, payloadToSave);
          }

          return jsonResp({ ok: true, kode });
        }

        // ── GET ARCHIVE ─────────────────────────────────────────
        case 'getArchive': {
          const { kode } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          let archiveData;
          if (r2) {
            const obj = await r2.get(`archive/${kode}.json`);
            if (obj) archiveData = await obj.json();
          }
          if (!archiveData) {
            const legacy = await kv.get(`archive:${kode}`, 'json');
            archiveData = legacy;
          }
          
          if (!archiveData) return jsonResp({ ok: false, error: 'Archive tidak ditemukan' }, 404);
          return jsonResp({ ok: true, data: archiveData });
        }

        case 'delete': {
          const { kode } = data;
          if (!kode) return jsonResp({ ok: false, error: 'kode required' }, 400);

          const tasks = [
            kv.delete(`meta:${kode}`),
            kv.delete(`expired:${kode}`),
            kv.delete(`stock:${kode}`),
            kv.delete(`csv:${kode}`)
          ];
          if (r2) {
            tasks.push(r2.delete(`stock/${kode}.json`));
            tasks.push(r2.delete(`csv/${kode}.json`));
          }
          await Promise.all(tasks);
          // archive/{kode}.json SENGAJA TIDAK dihapus — snapshot final
          // dianggap catatan permanen (sama seperti CSVStockwiz global).

          return jsonResp({ ok: true, deleted: kode });
        }

        default:
          return jsonResp({ ok: false, error: `Unknown action: ${action}` }, 400);
      }
    } catch (e) {
      console.error('[so-api]', action, e);
      return jsonResp({ ok: false, error: e.message }, 500);
    }
  }
};

// ─── Helpers ──────────────────────────────────────────────────

function generateKode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let kode = '';
  for (let i = 0; i < 6; i++) {
    kode += chars[Math.floor(Math.random() * chars.length)];
  }
  return kode;
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Enumerasi semua kode sesi langsung dari KV lewat prefix 'meta:',
// dengan pagination (kv.list() defaultnya max 1000 key per panggilan).
// Menggantikan index:sesi lama yang rawan race condition.
async function listMetaKodes(kv) {
  const kodes = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'meta:', cursor });
    for (const k of page.keys) {
      kodes.push(k.name.slice('meta:'.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return kodes;
}

async function putStock(r2, kv, kode, products) {
  if (r2) {
    await r2.put(`stock/${kode}.json`, JSON.stringify(products), {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    await kv.put(`stock:${kode}`, JSON.stringify(products));
  }
}

async function getStock(r2, kv, kode) {
  if (r2) {
    const obj = await r2.get(`stock/${kode}.json`);
    if (obj) return await obj.json();
  }
  const legacy = await kv.get(`stock:${kode}`, 'json');
  return legacy || [];
}

async function putCsv(r2, kv, kode, csvObj) {
  if (r2) {
    await r2.put(`csv/${kode}.json`, JSON.stringify(csvObj), {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    await kv.put(`csv:${kode}`, JSON.stringify(csvObj));
  }
}

async function getCsv(r2, kv, kode) {
  if (r2) {
    const obj = await r2.get(`csv/${kode}.json`);
    if (obj) return await obj.json();
  }
  const legacy = await kv.get(`csv:${kode}`, 'json');
  return legacy || null;
}

async function putExpired(r2, kv, kode, expObj) {
  if (r2) {
    await r2.put(`expired/${kode}.json`, JSON.stringify(expObj), {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    await kv.put(`expired:${kode}`, JSON.stringify(expObj));
  }
}

async function getExpired(r2, kv, kode) {
  if (r2) {
    const obj = await r2.get(`expired/${kode}.json`);
    if (obj) return await obj.json();
  }
  const legacy = await kv.get(`expired:${kode}`, 'json');
  return legacy || { expireds: [] };
}
