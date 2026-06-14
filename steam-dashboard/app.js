// STEAM TREND TRACKER — app.js
// Koneksi Firestore + render semua section dashboard

// Firebase Config
// Ganti dengan config Firebase proyek
// Dapatkan dari: GCP Console → Firebase → Project Settings → Your Apps
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyB1h6cl7HMz6hwRNqULX3nX40uK1NvBSgw",
    authDomain: "steam-trend-tracker.firebaseapp.com",
    projectId: "steam-trend-tracker",
    storageBucket: "steam-trend-tracker.firebasestorage.app",
    messagingSenderId: "207894125681",
    appId: "1:207894125681:web:e6912c5a2527ef69998fd0",
    measurementId: "G-LKHJ57GV8R"
};

// Cloud Functions URLs
const FUNCTIONS_BASE = "https://us-central1-steam-trend-tracker.cloudfunctions.net";
 
const ENDPOINTS = {
  spikes:      `${FUNCTIONS_BASE}/getSpikeAlerts`,
  reviews:     `${FUNCTIONS_BASE}/getGameReviews`,
  prices:      `${FUNCTIONS_BASE}/getGamePrices`,
  library:     `${FUNCTIONS_BASE}/getUserLibrary`,
};
 
// Chart.js Global Config 
Chart.defaults.color = "#6b7f99";
Chart.defaults.font.family = "JetBrains Mono";
Chart.defaults.font.size = 10;
Chart.defaults.borderColor = "#1e2535";
 
const CHART_COLORS = {
  blue:  "rgba(27, 154, 223, ",
  teal:  "rgba(0, 200, 160, ",
  amber: "rgba(245, 166, 35, ",
  red:   "rgba(232, 68, 90, ",
};
 
// State 
let db;
let barChartInstance    = null;
let trendChartInstance  = null;
let compareChartInstance = null;
let cachedGames = [];  // [{appid, name}, ...]
 
// INIT
async function init() {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
 
  // Load semua section secara paralel
  await Promise.allSettled([
    loadTopGames(),       // Bar chart + populate selects
    loadSpikeAlerts(),    // Spike banner
    loadReviews(),        // Review cards
    loadPrices(),         // Price list
  ]);
 
  // Setup event listeners
  document.getElementById("compareBtn").addEventListener("click", renderCompareChart);
  document.getElementById("libraryBtn").addEventListener("click", lookupLibrary);
  setupGlobalSearch();
  setupModal();
}
 
// BAGIAN 1: TOP 10 BAR CHART (DATA DARI FIRESTORE)
async function loadTopGames() {
  const snap = await db
    .collection("games")
    .orderBy("peak_in_game", "desc")
    .limit(10)
    .get();
 
  if (snap.empty) return;
 
  cachedGames = snap.docs.map((d) => ({
    appid: d.data().appid,
    name: d.data().name,
    players: d.data().peak_in_game,
    updated_at: d.data().updated_at?.toDate(),
  }));
 
  // Update last updated badge
  if (cachedGames[0]?.updated_at) {
    document.getElementById("lastUpdated").textContent =
      "⟳ " + cachedGames[0].updated_at.toLocaleString("id-ID");
  }
 
  renderBarChart(cachedGames.slice(0, 10));
  setupAllAutocomplete(cachedGames);
}
 
function renderBarChart(games) {
  const ctx = document.getElementById("barChart").getContext("2d");

  if (barChartInstance) barChartInstance.destroy();

  const labels = games.map((g) => truncate(g.name, 20));
  const values = games.map((g) => g.players);
  const maxVal  = Math.max(...values);

  barChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Pemain Aktif",
        data: values,
        backgroundColor: values.map((v) =>
          `rgba(27, 154, 223, ${0.3 + (v / maxVal) * 0.6})`
        ),
        borderColor: values.map((v) =>
          `rgba(27, 154, 223, ${0.5 + (v / maxVal) * 0.5})`
        ),
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.raw.toLocaleString("id-ID")} pemain`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "#1e2535" },
          ticks: { callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
        },
        y: { grid: { display: false } },
      },
    },
  });
}
 
// ═══════════════════════════════════════════════════════════════════════════
// BAGIAN 2: TREND CHART (HISTORI DARI SNAPSHOTS)
// ═══════════════════════════════════════════════════════════════════════════
async function loadTrendChart(appid) {
  if (!appid) return;
 
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
 
  const snap = await db
    .collection("snapshots")
    .where("appid", "==", appid)
    .where("timestamp", ">=", firebase.firestore.Timestamp.fromDate(twentyFourHoursAgo))
    .orderBy("timestamp", "asc")
    .get();
 
  const points = snap.docs.map((d) => ({
    x: d.data().timestamp.toDate(),
    y: d.data().players,
  }));
 
  if (points.length === 0) {
    // Belum ada data tren — tampilkan pesan
    const ctx = document.getElementById("trendChart").getContext("2d");
    if (trendChartInstance) trendChartInstance.destroy();
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = "#3d4f66";
    ctx.font = "11px JetBrains Mono";
    ctx.textAlign = "center";
    ctx.fillText("Belum ada data tren (tunggu scheduler berjalan)", ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }
 
  renderTrendChart(points);
}
 
function renderTrendChart(points) {
  const ctx = document.getElementById("trendChart").getContext("2d");
  if (trendChartInstance) trendChartInstance.destroy();
 
  trendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [{
        label: "Pemain",
        data: points,
        borderColor: "#1b9adf",
        backgroundColor: "rgba(27,154,223,0.08)",
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: "#1b9adf",
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctx) => ctx[0].raw.x.toLocaleString("id-ID"),
            label: (ctx) => ` ${ctx.raw.y.toLocaleString("id-ID")} pemain`,
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: "hour",
            displayFormats: { hour: "HH:mm" },
          },
          grid: { color: "#1e2535" },
        },
        y: {
          grid: { color: "#1e2535" },
          ticks: { callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
        },
      },
    },
  });
}
 
// ═══════════════════════════════════════════════════════════════════════════
// BAGIAN 3: SPIKE ALERTS

async function loadSpikeAlerts() {
  try {
    const res = await fetch(ENDPOINTS.spikes);
    const data = await res.json();
 
    if (!data.spikes || data.spikes.length === 0) return;
 
    const section = document.getElementById("spikeSection");
    const list    = document.getElementById("spikeList");
 
    list.innerHTML = data.spikes
      .map(
        (s) =>
          `<span class="spike-item">
            ${truncate(s.name, 24)} ▲ +${s.change_pct}%
          </span>`
      )
      .join("");
 
    section.classList.remove("hidden");
  } catch (_) {
    // Spike endpoint gagal — tidak critical, biarkan saja
  }
}
 

// BAGIAN 4: GAME COMPARISON CHART
// ═══════════════════════════════════════════════════════════════════════════
async function renderCompareChart() {
  const gameA = selectedGames.compareA;
  const gameB = selectedGames.compareB;
 
  if (!gameA || !gameB) {
    alert("Pilih dua game terlebih dahulu!");
    return;
  }
  if (gameA.appid === gameB.appid) {
    alert("Pilih dua game yang berbeda!");
    return;
  }
 
  const nameA = gameA.name;
  const nameB = gameB.name;
 
  const [snapA, snapB] = await Promise.all([
    db.collection("snapshots").where("appid", "==", gameA.appid).orderBy("timestamp", "asc").limit(48).get(),
    db.collection("snapshots").where("appid", "==", gameB.appid).orderBy("timestamp", "asc").limit(48).get(),
  ]);
 
  const toPoints = (snap) =>
    snap.docs.map((d) => ({ x: d.data().timestamp.toDate(), y: d.data().players }));
 
  const pointsA = toPoints(snapA);
  const pointsB = toPoints(snapB);
 
  const ctx = document.getElementById("compareChart").getContext("2d");
  if (compareChartInstance) compareChartInstance.destroy();
 
  compareChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: nameA,
          data: pointsA,
          borderColor: "#1b9adf",
          backgroundColor: "rgba(27,154,223,0.06)",
          borderWidth: 2, pointRadius: 3, fill: true, tension: 0.4,
        },
        {
          label: nameB,
          data: pointsB,
          borderColor: "#00c8a0",
          backgroundColor: "rgba(0,200,160,0.06)",
          borderWidth: 2, pointRadius: 3, fill: true, tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: { color: "#d4dce8", font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            title: (ctx) => ctx[0].raw.x.toLocaleString("id-ID"),
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw.y.toLocaleString("id-ID")} pemain`,
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "hour", displayFormats: { hour: "DD/MM HH:mm" } },
          grid: { color: "#1e2535" },
        },
        y: {
          grid: { color: "#1e2535" },
          ticks: { callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v },
        },
      },
    },
  });
}
 

// BAGIAN 5: REVIEW SCORE — searchable dari all_games
async function loadReviews() {
  const container = document.getElementById("reviewList");

  try {
    // Pakai game_reviews (simple collection, no composite index needed)
    // Fallback ke all_games kalau game_reviews kosong
    let snap = await db
      .collection("game_reviews")
      .orderBy("total_reviews", "desc")
      .limit(10)
      .get();

    if (snap.empty) {
      snap = await db
        .collection("all_games")
        .where("enriched", "==", true)
        .orderBy("total_reviews", "desc")
        .limit(10)
        .get();
    }

    if (snap.empty) {
      container.innerHTML = `<div class="empty-state">Belum ada data review.</div>`;
      return;
    }

    renderReviewList(snap.docs.map(d => d.data()), container);
  } catch (err) {
    console.error("loadReviews error:", err);
    container.innerHTML = `<div class="empty-state">Gagal memuat data review.</div>`;
  }
}

function renderReviewList(games, container) {
  container.innerHTML = games
    .map((d) => {
      const pct = parseFloat(d.positive_pct) || 0;
      const scoreClass = pct >= 80 ? "positive" : pct >= 60 ? "mixed" : "negative";
      const totalReviews = (d.total_reviews || 0).toLocaleString("id-ID");
      return `
        <div class="review-item fade-in">
          <div>
            <div class="review-name">${escHtml(d.name)}</div>
            <div class="review-meta">${totalReviews} ulasan total</div>
          </div>
          <div class="review-score-badge score--${scoreClass}">
            ${escHtml(d.review_score_desc || (pct + "%"))}
          </div>
          <div class="review-bar-wrap">
            <div class="review-bar" style="width:${pct}%; background: ${pct >= 80 ? "var(--steam-green)" : pct >= 60 ? "var(--steam-amber)" : "var(--steam-red)"}"></div>
          </div>
        </div>
      `;
    })
    .join("");
}


 
// ═══════════════════════════════════════════════════════════════════════════
// BAGIAN 6: PRICE & DISCOUNT — searchable dari all_games
async function loadPrices() {
  const container = document.getElementById("priceList");

  try {
    // Pakai game_prices (simple orderBy, no composite index needed)
    // Fallback ke all_games kalau game_prices kosong
    let snap = await db
      .collection("game_prices")
      .orderBy("discount_pct", "desc")
      .limit(10)
      .get();

    if (snap.empty) {
      snap = await db
        .collection("all_games")
        .where("enriched", "==", true)
        .orderBy("discount_pct", "desc")
        .limit(10)
        .get();
    }

    if (snap.empty) {
      container.innerHTML = `<div class="empty-state">Belum ada data harga.</div>`;
      return;
    }

    renderPriceList(snap.docs.map(d => d.data()), container);
  } catch (err) {
    console.error("loadPrices error:", err);
    container.innerHTML = `<div class="empty-state">Gagal memuat data harga.</div>`;
  }
}

function renderPriceList(games, container) {
  container.innerHTML = games
    .map((d) => {
      const isFree    = d.is_free || d.final_price === 0;
      const isOnSale  = d.is_on_sale;
      const priceFinal    = d.price_formatted   || d.formatted_final   || "—";
      const priceOriginal = d.formatted_initial || "";
      const discountPct   = d.discount_pct      || 0;

      return `
        <div class="price-item fade-in">
          <div class="price-name">${escHtml(d.name)}</div>
          <div class="price-right">
            ${isOnSale && priceOriginal ? `<span class="price-original">${escHtml(priceOriginal)}</span>` : ""}
            ${isFree
              ? `<span class="free-tag">FREE</span>`
              : `<span class="price-final">${escHtml(priceFinal)}</span>`
            }
            ${isOnSale ? `<span class="discount-tag">-${discountPct}%</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}


 
// BAGIAN 7: USER LIBRARY LOOKUP (CALL CLOUD FUNCTION LANGSUNG)
async function lookupLibrary() {
  const steamid = document.getElementById("steamIdInput").value.trim();
  const container = document.getElementById("libraryContent");
  const btn = document.getElementById("libraryBtn");
 
  if (!/^\d{17}$/.test(steamid)) {
    container.innerHTML = `<div class="error-state">SteamID64 harus 17 digit angka.</div>`;
    return;
  }
 
  btn.disabled = true;
  btn.textContent = "Memuat...";
  container.innerHTML = `<div class="skeleton-loader"></div>`;
 
  try {
    const res = await fetch(`${ENDPOINTS.library}?steamid=${steamid}`);
    const data = await res.json();
 
    if (!res.ok || data.error) {
      container.innerHTML = `<div class="error-state">${escHtml(data.error || "Error tidak diketahui")}<br><small style="color:var(--text-secondary)">${escHtml(data.hint || "")}</small></div>`;
      return;
    }
 
    if (!data.top20_by_playtime || data.top20_by_playtime.length === 0) {
      container.innerHTML = `<div class="empty-state">${escHtml(data.note || "Tidak ada game ditemukan.")}</div>`;
      return;
    }
 
    const maxHours = parseFloat(data.top20_by_playtime[0].playtime_forever_hours);
 
    container.innerHTML = `
      <div class="library-summary">
        SteamID: ${escHtml(steamid)} · ${data.total_games.toLocaleString("id-ID")} game total
      </div>
      ${data.top20_by_playtime
        .map((g, i) => {
          const barWidth = maxHours > 0 ? (parseFloat(g.playtime_forever_hours) / maxHours) * 100 : 0;
          const recent = parseFloat(g.playtime_2weeks_hours) > 0
            ? ` · ${g.playtime_2weeks_hours}j (2 minggu)`
            : "";
          return `
            <div class="library-item fade-in">
              <span class="library-rank">${String(i + 1).padStart(2, "0")}</span>
              ${g.img_icon_url
                ? `<img class="library-icon" src="${escHtml(g.img_icon_url)}" alt="" loading="lazy" />`
                : `<div class="library-icon"></div>`
              }
              <div class="library-info">
                <div class="library-name">${escHtml(g.name)}</div>
                <div class="library-hours">${g.playtime_forever_hours}j${recent}</div>
              </div>
              <div class="library-bar-wrap">
                <div class="library-bar" style="width:${barWidth}%"></div>
              </div>
            </div>
          `;
        })
        .join("")}
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-state">Gagal menghubungi server.<br><small style="color:var(--text-secondary)">${escHtml(err.message)}</small></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Cari";
  }
}
 
// ═══════════════════════════════════════════════════════════════════════════
// AUTOCOMPLETE SEARCH
// ═══════════════════════════════════════════════════════════════════════════
 
// State untuk menyimpan game yang dipilih di setiap search box
const selectedGames = {
  trend:    null,  // { appid, name }
  compareA: null,
  compareB: null,
};
 
/**
 * Buat autocomplete untuk satu input.
 * @param {string} inputId    - ID elemen <input>
 * @param {string} dropdownId - ID elemen dropdown
 * @param {function} onSelect - callback({ appid, name }) saat game dipilih
 * @param {function} onClear  - (opsional) callback saat input dikosongkan
 * @param {boolean} useFirestore - kalau true, search dari Firestore all_games (bukan cachedGames)
 */
function setupAutocomplete(inputId, dropdownId, onSelect, onClear = null, useFirestore = false) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let debounceTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);

    if (q.length < 1) {
      dropdown.classList.add("hidden");
      if (onClear) onClear();
      return;
    }

    if (useFirestore) {
      debounceTimer = setTimeout(() => searchAutocomplete(q, input, dropdown, onSelect), 250);
      return;
    }

    // Filter dari cachedGames (untuk tren & compare — hanya butuh top 50)
    const matches = cachedGames
      .filter((g) => g.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8);

    if (matches.length === 0) {
      dropdown.classList.add("hidden");
      return;
    }

    dropdown.innerHTML = matches
      .map(
        (g) => `
        <div class="autocomplete-item" data-appid="${g.appid}" data-name="${escHtml(g.name)}">
          <span class="ac-name">${highlightMatch(g.name, q)}</span>
          <span class="ac-players">${g.players?.toLocaleString("id-ID") || ""} pemain</span>
        </div>
      `
      )
      .join("");

    dropdown.classList.remove("hidden");

    // Klik item
    dropdown.querySelectorAll(".autocomplete-item").forEach((item) => {
      item.addEventListener("click", () => {
        const appid = parseInt(item.dataset.appid);
        const name  = item.dataset.name;
        input.value = name;
        dropdown.classList.add("hidden");
        onSelect({ appid, name });
      });
    });
  });
 
  // Tutup dropdown kalau klik di luar
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
 
  // Navigasi keyboard
  input.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".autocomplete-item");
    const active = dropdown.querySelector(".autocomplete-item.active");
    let idx = Array.from(items).indexOf(active);
 
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (idx < items.length - 1) {
        active?.classList.remove("active");
        items[idx + 1].classList.add("active");
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx > 0) {
        active?.classList.remove("active");
        items[idx - 1].classList.add("active");
      }
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      active.click();
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden");
    }
  });
}
 
function highlightMatch(name, query) {
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escHtml(name);
  return (
    escHtml(name.slice(0, idx)) +
    `<mark>${escHtml(name.slice(idx, idx + query.length))}</mark>` +
    escHtml(name.slice(idx + query.length))
  );
}
 
// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Setup semua autocomplete setelah cachedGames terisi
function setupAllAutocomplete(games) {
  // Tren pemain
  setupAutocomplete("trendSearch", "trendDropdown", ({ appid, name }) => {
    selectedGames.trend = { appid, name };
    loadTrendChart(appid);
  });
 
  // Perbandingan A
  setupAutocomplete("compareSearchA", "compareDropdownA", ({ appid, name }) => {
    selectedGames.compareA = { appid, name };
  });
 
  // Perbandingan B
  setupAutocomplete("compareSearchB", "compareDropdownB", ({ appid, name }) => {
    selectedGames.compareB = { appid, name };
  });

  // Default — isi input dengan game pertama & kedua
  if (games[0]) {
    document.getElementById("trendSearch").value    = games[0].name;
    document.getElementById("compareSearchA").value = games[0].name;
    selectedGames.trend    = games[0];
    selectedGames.compareA = games[0];
    loadTrendChart(games[0].appid);
  }
  if (games[1]) {
    document.getElementById("compareSearchB").value = games[1].name;
    selectedGames.compareB = games[1];
  }
}
 
// UTILS
function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}
 
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
 
// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL SEARCH — cari dari koleksi all_games di Firestore
let searchDebounceTimer = null;
 
function setupGlobalSearch() {
  const input    = document.getElementById("globalSearch");
  const dropdown = document.getElementById("globalDropdown");
  const countEl  = document.getElementById("globalSearchCount");
 
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(searchDebounceTimer);
 
    if (q.length < 2) {
      dropdown.classList.add("hidden");
      countEl.classList.add("hidden");
      return;
    }
 
    // Debounce 300ms — tunggu user selesai ketik
    searchDebounceTimer = setTimeout(() => searchGames(q, dropdown, countEl), 300);
  });
 
  // Tutup dropdown kalau klik di luar
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
 
  // Keyboard navigation
  input.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".global-item");
    const active = dropdown.querySelector(".global-item.active");
    let idx = Array.from(items).indexOf(active);
 
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active?.classList.remove("active");
      items[Math.min(idx + 1, items.length - 1)]?.classList.add("active");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active?.classList.remove("active");
      items[Math.max(idx - 1, 0)]?.classList.add("active");
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      active.click();
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden");
      input.blur();
    }
  });
}
 
async function searchGames(query, dropdown, countEl) {
  // Query Firestore — cari di all_games berdasarkan nama
  // Firestore tidak support LIKE/contains, jadi pakai range query trick
  // Ini mencari nama yang dimulai dengan query (case-sensitive Firestore)
  const q = query.toLowerCase();
  const qEnd = q.slice(0, -1) + String.fromCharCode(q.charCodeAt(q.length - 1) + 1);
 
  try {
    // Search di all_games — pakai where name >= query AND name < qEnd
    // Untuk case-insensitive, kita simpan field name_lower saat enrich
    // Fallback: ambil semua yang mengandung query dari hasil limit
    let results = [];
 
    // Coba exact prefix match dulu di all_games
    const snap = await db
      .collection("all_games")
      .orderBy("name")
      .startAt(query)
      .endAt(query + "\uf8ff")
      .limit(10)
      .get();
 
    results = snap.docs.map((d) => ({ ...d.data(), source: "all_games" }));
 
    // Kalau hasil kurang dari 5, tambahkan dari koleksi games (top players)
    if (results.length < 5) {
      const topSnap = await db
        .collection("games")
        .orderBy("name")
        .startAt(query)
        .endAt(query + "\uf8ff")
        .limit(5)
        .get();
 
      const topResults = topSnap.docs.map((d) => ({ ...d.data(), source: "games" }));
 
      // Merge tanpa duplikat
      const existingIds = new Set(results.map((r) => r.appid));
      topResults.forEach((r) => {
        if (!existingIds.has(r.appid)) results.push(r);
      });
    }
 
    if (results.length === 0) {
      dropdown.innerHTML = `<div class="global-search-empty">Tidak ada game ditemukan untuk "<strong>${escHtml(query)}</strong>"</div>`;
      dropdown.classList.remove("hidden");
      countEl.classList.add("hidden");
      return;
    }
 
    countEl.textContent = `${results.length} hasil`;
    countEl.classList.remove("hidden");
 
    dropdown.innerHTML = results
      .map((g) => {
        const isEnriched = g.enriched === true;
        const players = g.peak_in_game
          ? `${g.peak_in_game.toLocaleString("id-ID")} pemain`
          : g.genres?.length
          ? g.genres.slice(0, 2).join(", ")
          : "";
        const badgeClass = isEnriched ? "badge--enriched" : "badge--pending";
        const badgeText  = isEnriched ? "✓ Data lengkap" : "⏳ Pending";
        const iconUrl    = g.header_image || "";
 
        return `
          <div class="global-item" data-appid="${g.appid}" data-enriched="${isEnriched}">
            ${iconUrl
              ? `<img class="global-item-icon" src="${escHtml(iconUrl)}" alt="" onerror="this.style.display='none'" loading="lazy" />`
              : `<div class="global-item-icon"></div>`
            }
            <div class="global-item-info">
              <div class="global-item-name">${highlightMatch(g.name, query)}</div>
              <div class="global-item-sub">${escHtml(players)}</div>
            </div>
            <span class="global-item-badge ${badgeClass}">${badgeText}</span>
          </div>
        `;
      })
      .join("");
 
    dropdown.classList.remove("hidden");
 
    // Klik item → buka modal
    dropdown.querySelectorAll(".global-item").forEach((item) => {
      item.addEventListener("click", () => {
        const appid = parseInt(item.dataset.appid);
        dropdown.classList.add("hidden");
        document.getElementById("globalSearch").value = "";
        countEl.classList.add("hidden");
        openGameModal(appid);
      });
    });
 
  } catch (err) {
    dropdown.innerHTML = `<div class="global-search-empty">Error: ${escHtml(err.message)}</div>`;
    dropdown.classList.remove("hidden");
  }
}
 
// GAME DETAIL MODAL
async function openGameModal(appid) {
  const modal      = document.getElementById("gameModal");
  const loading    = document.getElementById("modalLoading");
  const content    = document.getElementById("modalContent");
  const notEnriched = document.getElementById("modalNotEnriched");
  const infoGrid   = document.getElementById("modalInfoGrid");
 
  // Reset & tampilkan modal
  modal.classList.remove("hidden");
  loading.style.display = "flex";
  content.classList.add("hidden");
  document.body.style.overflow = "hidden";
 
  try {
    // Cari di all_games dulu, fallback ke games
    let data = null;
    const allGamesDoc = await db.collection("all_games").doc(String(appid)).get();
 
    if (allGamesDoc.exists) {
      data = allGamesDoc.data();
    } else {
      const gamesDoc = await db.collection("games").doc(String(appid)).get();
      if (gamesDoc.exists) data = gamesDoc.data();
    }
 
    loading.style.display = "none";
    content.classList.remove("hidden");
 
    if (!data) {
      content.innerHTML = `<div class="empty-state">Data game tidak ditemukan.</div>`;
      return;
    }
 
    const isEnriched = data.enriched === true;
 
    // Isi header
    document.getElementById("modalName").textContent = data.name || `App ${appid}`;
    document.getElementById("modalSteamLink").href = `https://store.steampowered.com/app/${appid}`;
 
    // Image
    const img = document.getElementById("modalImage");
    if (data.header_image) {
      img.src = data.header_image;
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }
 
    // Badges
    const badgesEl = document.getElementById("modalBadges");
    const badges = [];
    if (data.is_free) badges.push(`<span class="global-item-badge badge--enriched">FREE TO PLAY</span>`);
    if (data.is_on_sale) badges.push(`<span class="global-item-badge badge--enriched">SALE -${data.discount_pct}%</span>`);
    if (data.coming_soon) badges.push(`<span class="global-item-badge badge--pending">COMING SOON</span>`);
    badgesEl.innerHTML = badges.join("");
 
    // Release date
    document.getElementById("modalRelease").textContent = data.release_date
      ? `Rilis: ${data.release_date}` : "";
 
    // Not enriched notice
    if (!isEnriched) {
      notEnriched.classList.remove("hidden");
      infoGrid.style.opacity = "0.4";
    } else {
      notEnriched.classList.add("hidden");
      infoGrid.style.opacity = "1";
    }
 
    // Harga
    const priceEl = document.getElementById("modalPrice");
    if (data.is_free) {
      priceEl.innerHTML = `<span style="color:var(--steam-teal)">Gratis</span>`;
    } else if (data.price_formatted) {
      priceEl.innerHTML = data.is_on_sale
        ? `<span style="color:var(--steam-teal)">${escHtml(data.price_formatted)}</span> <span style="color:var(--text-dim);text-decoration:line-through;font-size:11px">diskon ${data.discount_pct}%</span>`
        : escHtml(data.price_formatted);
    } else {
      priceEl.textContent = "—";
    }
 
    // Review
    const reviewEl = document.getElementById("modalReview");
    if (data.review_score_desc && data.total_reviews > 0) {
      const pct = data.positive_pct || 0;
      const color = pct >= 80 ? "var(--steam-green)" : pct >= 60 ? "var(--steam-amber)" : "var(--steam-red)";
      reviewEl.innerHTML = `<span style="color:${color}">${escHtml(data.review_score_desc)}</span><br><span style="font-size:11px;color:var(--text-secondary)">${data.total_reviews.toLocaleString("id-ID")} ulasan · ${pct}% positif</span>`;
    } else {
      reviewEl.textContent = "—";
    }
 
    // Developer
    document.getElementById("modalDev").textContent =
      data.developers?.join(", ") || data.publishers?.join(", ") || "—";
 
    // Genre
    document.getElementById("modalGenre").textContent =
      data.genres?.join(", ") || "—";
 
    // Metacritic
    const metaEl = document.getElementById("modalMetacritic");
    if (data.metacritic_score) {
      const mc = data.metacritic_score;
      const mcColor = mc >= 75 ? "var(--steam-green)" : mc >= 50 ? "var(--steam-amber)" : "var(--steam-red)";
      metaEl.innerHTML = `<span style="font-size:20px;font-weight:700;color:${mcColor}">${mc}</span><span style="font-size:11px;color:var(--text-secondary)"> / 100</span>`;
    } else {
      metaEl.textContent = "—";
    }
 
    // Platform
    const p = data.platforms || {};
    const platforms = [
      p.windows ? "Windows" : null,
      p.mac ? "Mac" : null,
      p.linux ? "Linux" : null,
    ].filter(Boolean);
    document.getElementById("modalPlatform2").textContent = platforms.join(", ") || "—";
 
    // Deskripsi
    const descEl = document.getElementById("modalDesc");
    descEl.textContent = data.short_description || (isEnriched ? "Tidak ada deskripsi." : "Belum tersedia.");
 
    // Kategori tags
    const catEl = document.getElementById("modalCat");
    if (data.categories?.length) {
      catEl.innerHTML = data.categories
        .slice(0, 10)
        .map((c) => `<span class="modal-tag">${escHtml(c)}</span>`)
        .join("");
    } else {
      catEl.innerHTML = `<span style="color:var(--text-dim);font-size:11px">—</span>`;
    }
 
  } catch (err) {
    loading.style.display = "none";
    content.classList.remove("hidden");
    content.innerHTML = `<div class="error-state">Gagal memuat data: ${escHtml(err.message)}</div>`;
  }
}
 
function setupModal() {
  const modal = document.getElementById("gameModal");
 
  document.getElementById("modalClose").addEventListener("click", () => {
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  });
 
  // Klik overlay untuk tutup
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
      document.body.style.overflow = "";
    }
  });
 
  // ESC untuk tutup
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      modal.classList.add("hidden");
      document.body.style.overflow = "";
    }
  });
}
 
// ─── Start ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);