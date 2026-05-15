const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");
const axios = require("axios");

// ─── Init ────────────────────────────────────────────────────────────────────
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Simpan API key di environment variable — JANGAN hardcode!
// Set via: gcloud functions deploy ... --set-env-vars STEAM_API_KEY=xxxxx
const STEAM_API_KEY = process.env.STEAM_API_KEY;

// Jumlah game yang di-fetch per siklus scheduler.
// Naikkan sampai 200 masih aman untuk free tier Firestore.
// Jangan melebihi 500 — Steam API bisa rate limit (429).
const GAME_LIMIT = 50;

// ─── FUNGSI LAMA (TIDAK DIUBAH) ───────────────────────────────────────────────

/**
 * Fase 4 original: Ambil top 10 game + simpan ke Firestore.
 * Trigger: Cloud Scheduler setiap jam.
 */
functions.http("fetchAndStoreSteamData", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const { data } = await axios.get(
      "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"
    );
    const games = data.response.ranks.slice(0, GAME_LIMIT);

    const batch = db.batch();
    const now = new Date();

    for (const game of games) {
      const detailRes = await axios.get(
        `https://store.steampowered.com/api/appdetails?appids=${game.appid}`
      );
      const detail = detailRes.data[game.appid]?.data || {};

      // Koleksi 'games' — info terkini
      const gameRef = db.collection("games").doc(String(game.appid));
      batch.set(gameRef, {
        appid: game.appid,
        name: detail.name || `App ${game.appid}`,
        header_image: detail.header_image || "",
        peak_in_game: game.peak_in_game,
        updated_at: admin.firestore.Timestamp.fromDate(now),
      });

      // Koleksi 'snapshots' — histori per jam
      const snapRef = db.collection("snapshots").doc();
      batch.set(snapRef, {
        appid: game.appid,
        name: detail.name || `App ${game.appid}`,
        players: game.peak_in_game,
        timestamp: admin.firestore.Timestamp.fromDate(now),
      });
    }

    await batch.commit();
    res.json({ success: true, updated: games.length, timestamp: now });
  } catch (err) {
    console.error("fetchAndStoreSteamData error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fase 4 original: Deteksi spike >20% dalam 1 jam terakhir.
 */
functions.http("getSpikeAlerts", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const snapshotsRef = db.collection("snapshots");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentSnaps = await snapshotsRef
      .where("timestamp", ">=", admin.firestore.Timestamp.fromDate(oneHourAgo))
      .orderBy("timestamp", "asc")
      .get();

    // Kelompokkan per appid
    const byApp = {};
    recentSnaps.forEach((doc) => {
      const d = doc.data();
      if (!byApp[d.appid]) byApp[d.appid] = [];
      byApp[d.appid].push(d);
    });

    const spikes = [];
    for (const [appid, snaps] of Object.entries(byApp)) {
      if (snaps.length < 2) continue;
      const first = snaps[0].players;
      const last = snaps[snaps.length - 1].players;
      const pct = ((last - first) / first) * 100;
      if (pct > 20) {
        spikes.push({ appid, name: snaps[0].name, change_pct: pct.toFixed(1) });
      }
    }

    res.json({ spikes });
  } catch (err) {
    console.error("getSpikeAlerts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FUNGSI BARU: FETCH SEMUA GAME STEAM SECARA BERTAHAP ─────────────────────

/**
 * Ambil semua game Steam menggunakan IStoreService/GetAppList dengan cursor pagination.
 * Tiap jam ambil 500 game baru, simpan cursor ke Firestore, jam berikutnya lanjut.
 * Dengan 500 game/jam, dalam 24 jam bisa dapat 12.000 game baru.
 *
 * Deploy:
 *   gcloud functions deploy fetchAllGames --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY \
 *     --timeout 540s --memory 512MB
 *
 * Tambahkan scheduler baru:
 *   Nama: fetch-all-games
 *   Frekuensi: 45 * * * * (menit ke-45 tiap jam)
 *   URL: URL fungsi fetchAllGames
 */
functions.http("fetchAllGames", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  if (!STEAM_API_KEY) {
    return res.status(400).json({ error: "STEAM_API_KEY env var tidak di-set" });
  }

  try {
    // Ambil cursor terakhir dari Firestore
    // Cursor ini menandai posisi terakhir fetch — disimpan agar tiap jam lanjut dari sini
    const cursorDoc = await db.collection("_meta").doc("fetchAllGames_cursor").get();
    const lastCursor = cursorDoc.exists ? cursorDoc.data().cursor : 0;

    // Fetch 500 game mulai dari cursor
    const { data } = await axios.get(
      "https://api.steampowered.com/IStoreService/GetAppList/v1/",
      {
        params: {
          key: STEAM_API_KEY,
          include_games: true,
          include_dlc: false,        // Skip DLC — kita cuma mau game
          include_software: false,   // Skip software
          include_videos: false,     // Skip video
          include_hardware: false,   // Skip hardware
          last_appid: lastCursor,    // Cursor pagination
          max_results: 500,          // Max per request
        },
      }
    );

    const apps = data?.response?.apps || [];
    const haveMoreResults = data?.response?.have_more_results || false;
    const nextCursor = data?.response?.last_appid || 0;

    if (apps.length === 0) {
      // Sudah habis semua game — reset cursor ke awal untuk mulai lagi
      await db.collection("_meta").doc("fetchAllGames_cursor").set({
        cursor: 0,
        reset_at: admin.firestore.FieldValue.serverTimestamp(),
        total_cycles: (cursorDoc.data()?.total_cycles || 0) + 1,
      });
      return res.json({
        success: true,
        message: "Semua game sudah di-fetch! Cursor direset ke awal.",
        apps_fetched: 0,
      });
    }

    // Simpan ke Firestore dengan batch — tiap dokumen pakai appid sebagai ID
    // Tulis per batch 400 (batas Firestore 500 per batch)
    const BATCH_SIZE = 400;
    let saved = 0;

    for (let i = 0; i < apps.length; i += BATCH_SIZE) {
      const chunk = apps.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const app of chunk) {
        if (!app.appid || !app.name) continue; // Skip entri kosong

        const ref = db.collection("all_games").doc(String(app.appid));
        batch.set(ref, {
          appid: app.appid,
          name: app.name,
          enriched: false,  // Flag untuk enrichAllGames
          fetched_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }); // merge:true agar tidak overwrite data yang sudah ada

        saved++;
      }

      await batch.commit();
    }

    // Simpan cursor berikutnya
    await db.collection("_meta").doc("fetchAllGames_cursor").set({
      cursor: haveMoreResults ? nextCursor : 0,  // Reset jika sudah habis
      last_run: admin.firestore.FieldValue.serverTimestamp(),
      last_fetched: saved,
      have_more: haveMoreResults,
      total_cycles: cursorDoc.data()?.total_cycles || 0,
    });

    res.json({
      success: true,
      apps_fetched: saved,
      next_cursor: nextCursor,
      have_more_results: haveMoreResults,
      message: haveMoreResults
        ? `${saved} game disimpan. Lanjut dari cursor ${nextCursor} jam berikutnya.`
        : `${saved} game disimpan. Semua game sudah habis, cursor direset.`,
    });

  } catch (err) {
    console.error("fetchAllGames error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cek status progress fetch semua game.
 * Buka URL fungsi ini di browser untuk lihat sudah berapa game yang terkumpul.
 *
 * Deploy:
 *   gcloud functions deploy getFetchProgress --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY
 */
functions.http("getFetchProgress", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const [cursorDoc, countSnap] = await Promise.all([
      db.collection("_meta").doc("fetchAllGames_cursor").get(),
      db.collection("all_games").count().get(),
    ]);

    const cursor = cursorDoc.exists ? cursorDoc.data() : {};
    const totalGames = countSnap.data().count;

    res.json({
      total_games_in_db: totalGames,
      current_cursor: cursor.cursor || 0,
      have_more: cursor.have_more,
      last_run: cursor.last_run?.toDate() || null,
      last_fetched: cursor.last_fetched || 0,
      total_cycles_completed: cursor.total_cycles || 0,
      estimated_total_steam_games: "~120.000",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ─── FUNGSI BARU: ENRICH ALL GAMES ───────────────────────────────────────────

/**
 * Ambil detail lengkap (harga, review, genre, developer) untuk 100 game
 * dari koleksi 'all_games' yang belum di-enrich, lalu update dokumennya.
 *
 * Cara kerja:
 * - Query all_games WHERE enriched == false, limit 100
 * - Untuk tiap game: fetch appdetails + appreviews dari Steam
 * - Update dokumen dengan data lengkap + set enriched = true
 * - Tiap jam jalan otomatis via scheduler → ~50 hari untuk 120.000 game
 *
 * Deploy:
 *   gcloud functions deploy enrichAllGames --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY \
 *     --timeout 540s --memory 512MB
 *
 * Scheduler baru:
 *   Nama: enrich-all-games
 *   Frekuensi: 30 * * * * (menit ke-30 tiap jam)
 *   URL: URL fungsi enrichAllGames
 */
functions.http("enrichAllGames", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  if (!STEAM_API_KEY) {
    return res.status(400).json({ error: "STEAM_API_KEY env var tidak di-set" });
  }

  const ENRICH_LIMIT = 100;
  // Delay antar request ke Steam API — hindari rate limit 429
  const DELAY_MS = 300;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // Ambil 100 game yang belum di-enrich
    const snap = await db
      .collection("all_games")
      .where("enriched", "==", false)
      .limit(ENRICH_LIMIT)
      .get();

    // Kalau semua sudah di-enrich, reset semua ke false untuk mulai lagi
    if (snap.empty) {
      // Cek apakah memang sudah habis atau belum ada data sama sekali
      const totalSnap = await db.collection("all_games").limit(1).get();

      if (totalSnap.empty) {
        return res.json({
          success: true,
          message: "Koleksi all_games masih kosong. Jalankan fetchAllGames dulu.",
          enriched: 0,
        });
      }

      // Reset semua game — mulai siklus enrich baru
      // Lakukan reset bertahap 400 per batch
      const allSnap = await db.collection("all_games").select().get();
      const BATCH_SIZE = 400;

      for (let i = 0; i < allSnap.docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        allSnap.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
          batch.update(doc.ref, { enriched: false });
        });
        await batch.commit();
      }

      return res.json({
        success: true,
        message: "Semua game sudah di-enrich! Mereset untuk siklus berikutnya.",
        enriched: 0,
        total_reset: allSnap.docs.length,
      });
    }

    const results = { success: 0, skipped: 0, failed: 0 };

    for (const doc of snap.docs) {
      const { appid, name } = doc.data();

      try {
        // Fetch detail game dari Steam Store API
        const detailRes = await axios.get(
          "https://store.steampowered.com/api/appdetails",
          {
            params: {
              appids: appid,
              cc: "id",  // Harga dalam IDR
              l: "english",
            },
            timeout: 8000,
          }
        );

        const detail = detailRes.data?.[appid]?.data;

        // Kalau game tidak ditemukan di Store (delisted/removed), tandai dan skip
        if (!detail) {
          await doc.ref.update({
            enriched: true,
            delisted: true,
            enriched_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          results.skipped++;
          await sleep(DELAY_MS);
          continue;
        }

        // Fetch review summary
        let reviewSummary = null;
        try {
          const reviewRes = await axios.get(
            `https://store.steampowered.com/appreviews/${appid}`,
            {
              params: {
                json: 1,
                language: "all",
                review_type: "all",
                purchase_type: "all",
                filter: "summary",
                key: STEAM_API_KEY,
              },
              timeout: 5000,
            }
          );
          reviewSummary = reviewRes.data?.query_summary || null;
        } catch (_) {
          // Review gagal tidak fatal — lanjut tanpa data review
        }

        // Susun data lengkap
        const enrichedData = {
          // Info dasar
          appid,
          name: detail.name || name,
          type: detail.type || "game",
          short_description: detail.short_description || "",
          header_image: detail.header_image || "",
          website: detail.website || "",

          // Developer & publisher
          developers: detail.developers || [],
          publishers: detail.publishers || [],

          // Genre & kategori
          genres: (detail.genres || []).map((g) => g.description),
          categories: (detail.categories || []).map((c) => c.description),

          // Platform
          platforms: {
            windows: detail.platforms?.windows || false,
            mac: detail.platforms?.mac || false,
            linux: detail.platforms?.linux || false,
          },

          // Tanggal rilis
          release_date: detail.release_date?.date || "",
          coming_soon: detail.release_date?.coming_soon || false,

          // Harga (IDR)
          is_free: detail.is_free || false,
          price_idr: detail.price_overview?.final
            ? detail.price_overview.final / 100
            : null,
          price_formatted: detail.price_overview?.final_formatted || null,
          discount_pct: detail.price_overview?.discount_percent || 0,
          is_on_sale: (detail.price_overview?.discount_percent || 0) > 0,

          // Review
          total_reviews: reviewSummary?.total_reviews || 0,
          positive_reviews: reviewSummary?.total_positive || 0,
          review_score_desc: reviewSummary?.review_score_desc || "",
          positive_pct: reviewSummary?.total_reviews > 0
            ? parseFloat(
                ((reviewSummary.total_positive / reviewSummary.total_reviews) * 100).toFixed(1)
              )
            : null,

          // Metacritic
          metacritic_score: detail.metacritic?.score || null,

          // Status enrich
          enriched: true,
          delisted: false,
          enriched_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        await doc.ref.set(enrichedData, { merge: true });
        results.success++;

      } catch (err) {
        // Kalau satu game gagal, jangan stop — tandai sebagai gagal dan lanjut
        console.warn(`enrichAllGames: gagal enrich appid ${appid} — ${err.message}`);
        await doc.ref.update({
          enriched: true,   // Tandai true agar tidak di-retry terus
          enrich_error: err.message,
          enriched_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        results.failed++;
      }

      // Delay 300ms antar game untuk hindari rate limit Steam
      await sleep(DELAY_MS);
    }

    res.json({
      success: true,
      ...results,
      total_processed: snap.docs.length,
      message: `${results.success} game berhasil di-enrich, ${results.skipped} delisted, ${results.failed} gagal.`,
    });

  } catch (err) {
    console.error("enrichAllGames error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cek status progress enrich.
 * Buka URL fungsi ini di browser untuk lihat berapa game sudah di-enrich.
 *
 * Deploy:
 *   gcloud functions deploy getEnrichProgress --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY
 */
functions.http("getEnrichProgress", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const [enrichedSnap, notEnrichedSnap, totalSnap] = await Promise.all([
      db.collection("all_games").where("enriched", "==", true).count().get(),
      db.collection("all_games").where("enriched", "==", false).count().get(),
      db.collection("all_games").count().get(),
    ]);

    const enriched    = enrichedSnap.data().count;
    const notEnriched = notEnrichedSnap.data().count;
    const total       = totalSnap.data().count;
    const pct         = total > 0 ? ((enriched / total) * 100).toFixed(1) : 0;

    // Estimasi waktu selesai
    const remaining      = notEnriched;
    const perHour        = 100;
    const hoursLeft      = Math.ceil(remaining / perHour);
    const daysLeft       = (hoursLeft / 24).toFixed(1);

    res.json({
      total_games: total,
      enriched,
      not_enriched: notEnriched,
      progress_pct: `${pct}%`,
      estimated_hours_left: hoursLeft,
      estimated_days_left: daysLeft,
      enrich_rate: `${perHour} game/jam`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FUNGSI LAMA: REVIEW SCORE & JUMLAH REVIEW ───────────────────────────────

/**
 * Ambil review score + jumlah review untuk top 10 game.
 * Endpoint: store.steampowered.com/appreviews/{appid}
 * Butuh: API key (untuk rate limit lebih tinggi, opsional tapi disarankan)
 *
 * Deploy:
 *   gcloud functions deploy getGameReviews --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY
 */
functions.http("getGameReviews", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const gamesSnap = await db.collection("games").limit(GAME_LIMIT).get();
    const results = [];

    for (const doc of gamesSnap.docs) {
      const { appid, name } = doc.data();
      const { data } = await axios.get(
        `https://store.steampowered.com/appreviews/${appid}`,
        {
          params: {
            json: 1,
            language: "all",
            review_type: "all",
            purchase_type: "all",
            filter: "summary",
            key: STEAM_API_KEY,
          },
        }
      );

      const summary = data?.query_summary || {};
      const reviewData = {
        appid,
        name,
        total_reviews: summary.total_reviews || 0,
        total_positive: summary.total_positive || 0,
        total_negative: summary.total_negative || 0,
        review_score: summary.review_score || 0,
        review_score_desc: summary.review_score_desc || "N/A",
        // Hitung persentase positif sendiri
        positive_pct:
          summary.total_reviews > 0
            ? (
                (summary.total_positive / summary.total_reviews) *
                100
              ).toFixed(1)
            : "0",
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Simpan ke koleksi 'game_reviews'
      await db
        .collection("game_reviews")
        .doc(String(appid))
        .set(reviewData, { merge: true });

      results.push(reviewData);
    }

    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    console.error("getGameReviews error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FUNGSI BARU: PRICE & DISCOUNT INFO ──────────────────────────────────────

/**
 * Ambil harga terkini + status diskon untuk top 10 game.
 * Endpoint: store.steampowered.com/api/appdetails (field price_overview)
 * Tidak butuh API key, tapi key meningkatkan rate limit.
 *
 * Deploy:
 *   gcloud functions deploy getGamePrices --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1
 *
 * Catatan: Steam tidak expose HISTORI harga lewat API resmi.
 * Fungsi ini menyimpan snapshot harga tiap jam ke koleksi 'price_history'
 * sehingga kita bisa build grafik tren harga sendiri.
 */
functions.http("getGamePrices", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const gamesSnap = await db.collection("games").limit(GAME_LIMIT).get();
    const results = [];
    const now = new Date();

    for (const doc of gamesSnap.docs) {
      const { appid, name } = doc.data();

      const { data } = await axios.get(
        `https://store.steampowered.com/api/appdetails`,
        {
          params: {
            appids: appid,
            filters: "price_overview",
            cc: "id",  // Country code Indonesia — harga dalam IDR
            l: "id",
          },
        }
      );

      const priceOverview = data?.[appid]?.data?.price_overview;

      if (!priceOverview) {
        // Game mungkin free-to-play atau tidak tersedia di region ini
        continue;
      }

      const priceData = {
        appid,
        name,
        currency: priceOverview.currency,
        // Steam mengembalikan harga dalam sen (cents), bagi 100 untuk rupiah/dollar
        initial_price: priceOverview.initial / 100,
        final_price: priceOverview.final / 100,
        discount_pct: priceOverview.discount_percent,
        is_on_sale: priceOverview.discount_percent > 0,
        formatted_initial: priceOverview.initial_formatted,
        formatted_final: priceOverview.final_formatted,
        timestamp: admin.firestore.Timestamp.fromDate(now),
      };

      // Simpan ke 'game_prices' untuk data terkini
      await db
        .collection("game_prices")
        .doc(String(appid))
        .set(priceData, { merge: true });

      // Simpan ke 'price_history' untuk grafik tren harga
      await db.collection("price_history").add(priceData);

      results.push(priceData);
    }

    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    console.error("getGamePrices error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FUNGSI BARU: OWNED GAMES & PLAYTIME PER USER ────────────────────────────

/**
 * Ambil daftar game + total playtime untuk satu Steam user.
 * Endpoint: ISteamUser/GetOwnedGames/v1/
 * Butuh: API key (wajib) + SteamID64 user (dari query param atau Firestore)
 *
 * Cara pakai: GET /getUserLibrary?steamid=76561198XXXXXXXX
 *
 * Deploy:
 *   gcloud functions deploy getUserLibrary --runtime nodejs22 \
 *     --trigger-http --allow-unauthenticated --region us-central1 \
 *     --set-env-vars STEAM_API_KEY=YOUR_KEY
 *
 * Catatan keamanan: Profil Steam user harus Public agar API ini berhasil.
 * Fungsi ini menerima SteamID64 dari query param — JANGAN simpan SteamID
 * di kode atau environment variable secara langsung.
 */
functions.http("getUserLibrary", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    if (!STEAM_API_KEY) {
      return res.status(400).json({ error: "STEAM_API_KEY env var tidak di-set" });
    }

    const steamid = req.query.steamid;
    if (!steamid) {
      return res.status(400).json({ error: "Query param 'steamid' wajib diisi" });
    }

    // Validasi SteamID64 — harus 17 digit angka
    if (!/^\d{17}$/.test(steamid)) {
      return res.status(400).json({ error: "SteamID64 tidak valid (harus 17 digit)" });
    }

    // Ambil daftar game yang dimiliki
    const { data: ownedData } = await axios.get(
      "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
      {
        params: {
          key: STEAM_API_KEY,
          steamid,
          include_appinfo: true,
          include_played_free_games: true,
        },
      }
    );

    const games = ownedData?.response?.games || [];
    if (games.length === 0) {
      return res.json({
        success: true,
        note: "Tidak ada game ditemukan. Pastikan profil Steam user adalah Public.",
        steamid,
        games: [],
      });
    }

    // Sort berdasarkan playtime terbanyak
    const sorted = games
      .sort((a, b) => b.playtime_forever - a.playtime_forever)
      .slice(0, 20); // Ambil top 20 saja

    const libraryData = sorted.map((g) => ({
      appid: g.appid,
      name: g.name,
      playtime_forever_minutes: g.playtime_forever,
      playtime_forever_hours: (g.playtime_forever / 60).toFixed(1),
      playtime_2weeks_minutes: g.playtime_2weeks || 0,
      playtime_2weeks_hours: ((g.playtime_2weeks || 0) / 60).toFixed(1),
      img_icon_url: g.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : "",
    }));

    // Simpan ke 'user_libraries' (cache 1 jam)
    await db
      .collection("user_libraries")
      .doc(steamid)
      .set({
        steamid,
        total_games: games.length,
        top20_by_playtime: libraryData,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({
      success: true,
      steamid,
      total_games: games.length,
      top20_by_playtime: libraryData,
    });
  } catch (err) {
    // Steam sering return 401 jika profil private
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(403).json({
        error: "Profil Steam private atau API key tidak valid",
        hint: "Pastikan profil Steam user diset ke Public di pengaturan privasi Steam",
      });
    }
    console.error("getUserLibrary error:", err.message);
    res.status(500).json({ error: err.message });
  }
});