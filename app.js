const DB_NAME = "senada-music-library";
const DB_VERSION = 3;
const DRIVE_BACKUP_NAME = "senada-library-v1";
const DRIVE_SCOPE = "openid email https://www.googleapis.com/auth/drive.appdata";
const BACKUP_MAGIC = "SENADA1\n";
const GOOGLE_ACCOUNT_KEY = "senada-google-account";
const EQUALIZER_STORAGE_KEY = "senada-equalizer";
const PLAYBACK_MODE_KEY = "senada-playback-mode";
const EQUALIZER_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, 1, 2],
  vocal: [-2, 1, 4, 3, 0],
  treble: [-1, 0, 0, 4, 6]
};
const audio = document.querySelector("#audio-player");
const trackList = document.querySelector("#track-list");
const emptyState = document.querySelector("#empty-state");
const uploadInput = document.querySelector("#music-input");
const playerBar = document.querySelector("#player-bar");
const playButton = document.querySelector("#play-button");
const toast = document.querySelector("#toast");
const connectionLabel = document.querySelector("#connection-label");
const playlistGrid = document.querySelector("#playlist-grid");
const playlistDetail = document.querySelector("#playlist-detail");
const playlistTrackList = document.querySelector("#playlist-track-list");
const recentTrackList = document.querySelector("#recent-track-list");
const statsPanel = document.querySelector("#audio-stats-panel");
const equalizerPanel = document.querySelector("#equalizer-panel");
const playingToolsButton = document.querySelector("#playing-tools-button");
const playingToolsMenu = document.querySelector("#playing-tools-menu");
const appShell = document.querySelector(".app-shell");
const nowPlayingScreen = document.querySelector("#now-playing-screen");
const waveformCanvas = document.querySelector("#waveform-canvas");
const objectUrls = new Map();
let database;
let tracks = [];
let playlists = [];
let recentHistory = [];
let syncMarkers = [];
let currentTrackId = null;
let selectedPlaylistId = null;
let playbackPlaylistId = null;
let googleAccessToken = null;
let googleTokenExpiresAt = 0;
let driveSyncInProgress = false;
let toastTimer;
let googleAccountEmail = localStorage.getItem(GOOGLE_ACCOUNT_KEY) || "";
let isNowPlayingOpen = false;
let audioContext = null;
let audioAnalyser = null;
let waveformFrame = null;
let waveformStartedAt = 0;
let waveformFrequencies = null;
let equalizerFilters = [];
let bassFilter = null;
let balancePanner = null;
let surroundWetGain = null;
let surroundDryGain = null;
let equalizerPreset = "flat";
let equalizerGains = EQUALIZER_PRESETS.flat.slice();
let balanceValue = 0;
let surroundValue = 0;
let bassValue = 0;
let playbackMode = "sequential";
let smartShuffleHistory = [];

const validPlaybackModes = ["sequential", "shuffle", "repeat", "smart"];

if (googleAccountEmail) {
  document.querySelector("#drive-sync-label").textContent = `Sinkronkan • ${googleAccountEmail}`;
  document.querySelector("#drive-sync-hint").textContent = `Akun di perangkat ini: ${googleAccountEmail}. Gunakan Gmail ini di perangkat lain.`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("tracks")) {
        const store = db.createObjectStore("tracks", { keyPath: "id" });
        store.createIndex("addedAt", "addedAt");
      }
      if (!db.objectStoreNames.contains("playlists")) {
        db.createObjectStore("playlists", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("recentlyPlayed")) {
        db.createObjectStore("recentlyPlayed", { keyPath: "trackId" });
      }
      if (!db.objectStoreNames.contains("syncMarkers")) {
        db.createObjectStore("syncMarkers", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Database tidak dapat dibuka."));
    request.onblocked = () => reject(new Error("Database musik sedang dipakai tab lain. Tutup tab Senada lain lalu coba lagi."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Permintaan penyimpanan gagal."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Penyimpanan musik dibatalkan."));
    transaction.onerror = () => reject(transaction.error || new Error("Penyimpanan musik gagal."));
  });
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAudioFormat(track) {
  const extension = track.file && track.file.name.match(/\.([^.]+)$/);
  if (extension) return extension[1].toUpperCase();
  const mimeSubtype = track.file && track.file.type.split("/")[1];
  return mimeSubtype ? mimeSubtype.replace(/^x-/, "").toUpperCase() : "Tidak diketahui";
}

function getEstimatedBitrate(track) {
  if (!track.duration || !Number.isFinite(track.duration) || track.duration <= 0 || !track.size) {
    return "Belum tersedia";
  }
  const kilobitsPerSecond = Math.round((track.size * 8) / track.duration / 1000);
  return `~${kilobitsPerSecond} kbps`;
}

function updateAudioStats(track) {
  document.querySelector("#stat-format").textContent = getAudioFormat(track);
  document.querySelector("#stat-size").textContent = formatSize(track.size);
  document.querySelector("#stat-duration").textContent = track.duration
    ? formatTime(track.duration)
    : "Memuat...";
  document.querySelector("#stat-bitrate").textContent = getEstimatedBitrate(track);
  document.querySelector("#now-playing-subtitle").textContent =
    `${getAudioFormat(track)} · ${getEstimatedBitrate(track)}`;
  document.querySelector("#playing-page-title").textContent = track.title;
  document.querySelector("#playing-page-format").textContent =
    `${getAudioFormat(track)} · ${formatTime(track.duration)} · ${formatSize(track.size)}`;
  document.querySelector("#playing-stat-format").textContent = getAudioFormat(track);
  document.querySelector("#playing-stat-bitrate").textContent = getEstimatedBitrate(track);
  document.querySelector("#playing-stat-size").textContent = formatSize(track.size);
  document.querySelector("#playing-track-stats").hidden = false;
}

function updateEqualizer(gains, preset, persist = true) {
  const sliders = Array.from(document.querySelectorAll(".equalizer-slider"));
  equalizerGains = sliders.map((slider, index) => {
    const rawGain = Number(gains[index]);
    const gain = Number.isFinite(rawGain) ? Math.max(-12, Math.min(12, rawGain)) : 0;
    slider.value = String(gain);
    document.querySelector(`#eq-value-${index}`).textContent = `${gain > 0 ? "+" : ""}${gain} dB`;
    if (equalizerFilters[index]) equalizerFilters[index].gain.value = gain;
    return gain;
  });
  equalizerPreset = preset;
  document.querySelector("#equalizer-preset").value = preset;
  if (persist) persistAudioPreferences();
}

function updateSoundEffects(nextValues, persist = true) {
  balanceValue = Math.max(-100, Math.min(100, Number(nextValues.balance) || 0));
  surroundValue = Math.max(0, Math.min(100, Number(nextValues.surround) || 0));
  bassValue = Math.max(0, Math.min(100, Number(nextValues.bass) || 0));

  document.querySelector("#balance-slider").value = String(balanceValue);
  document.querySelector("#balance-value").textContent = balanceValue === 0
    ? "Seimbang"
    : `${balanceValue < 0 ? "Kiri" : "Kanan"} ${Math.abs(balanceValue)}%`;
  document.querySelector("#surround-slider").value = String(surroundValue);
  document.querySelector("#surround-value").textContent = `${surroundValue}%`;
  document.querySelector("#bass-slider").value = String(bassValue);
  document.querySelector("#bass-value").textContent = `${bassValue}%`;

  if (balancePanner) balancePanner.pan.value = balanceValue / 100;
  if (surroundWetGain) surroundWetGain.gain.value = (surroundValue / 100) * 0.32;
  if (surroundDryGain) surroundDryGain.gain.value = 1 - (surroundValue / 100) * 0.12;
  if (bassFilter) bassFilter.gain.value = (bassValue / 100) * 12;
  if (persist) persistAudioPreferences();
}

function persistAudioPreferences() {
  try {
    localStorage.setItem(EQUALIZER_STORAGE_KEY, JSON.stringify({
      preset: equalizerPreset,
      gains: equalizerGains,
      balance: balanceValue,
      surround: surroundValue,
      bass: bassValue
    }));
  } catch (error) {
    console.error("Could not save audio preferences:", error);
    showToast(`Pengaturan audio gagal disimpan: ${error.message}`, true);
  }
}

function loadEqualizerPreferences() {
  const audioContextSupported = Boolean(window.AudioContext || window.webkitAudioContext);
  if (!audioContextSupported) {
    document.querySelectorAll(".equalizer-slider, .sound-effect-control input, #equalizer-preset").forEach((control) => {
      control.disabled = true;
    });
    document.querySelector("#equalizer-hint").textContent =
      "Equalizer audio tidak didukung browser ini. Coba browser versi terbaru.";
    return;
  }

  try {
    const savedPreferences = localStorage.getItem(EQUALIZER_STORAGE_KEY);
    if (!savedPreferences) {
      updateEqualizer(EQUALIZER_PRESETS.flat, "flat", false);
      return;
    }
    const parsedPreferences = JSON.parse(savedPreferences);
    if (!Array.isArray(parsedPreferences.gains) || parsedPreferences.gains.length !== 5) {
      throw new Error("Data preset equalizer tidak valid.");
    }
    const preset = parsedPreferences.preset === "custom" ||
      Object.prototype.hasOwnProperty.call(EQUALIZER_PRESETS, parsedPreferences.preset)
      ? parsedPreferences.preset
      : "custom";
    updateEqualizer(parsedPreferences.gains, preset, false);
    updateSoundEffects({
      balance: parsedPreferences.balance,
      surround: parsedPreferences.surround,
      bass: parsedPreferences.bass
    }, false);
  } catch (error) {
    console.error("Could not restore equalizer preferences:", error);
    updateEqualizer(EQUALIZER_PRESETS.flat, "flat", false);
    updateSoundEffects({ balance: 0, surround: 0, bass: 0 }, false);
    showToast(`Preset equalizer tidak dapat dimuat: ${error.message}`, true);
  }
}

function loadPlaybackMode() {
  const savedMode = localStorage.getItem(PLAYBACK_MODE_KEY);
  playbackMode = validPlaybackModes.includes(savedMode) ? savedMode : "sequential";
  updatePlaybackModeUi();
}

function updatePlaybackModeUi() {
  const labels = {
    sequential: "Urutan",
    shuffle: "Acak",
    repeat: "Pengulangan",
    smart: "Smart Shuffle"
  };
  const shuffleButton = document.querySelector("#shuffle-button");
  shuffleButton.setAttribute("aria-label", `Mode urutan musik: ${labels[playbackMode]}`);
  shuffleButton.title = labels[playbackMode];
  shuffleButton.classList.toggle("is-active", playbackMode !== "sequential");
  document.querySelectorAll("[data-playback-mode]").forEach((option) => {
    option.setAttribute("aria-checked", String(option.dataset.playbackMode === playbackMode));
  });
}

function setPlaybackMode(mode) {
  if (!validPlaybackModes.includes(mode)) return;
  playbackMode = mode;
  smartShuffleHistory = [];
  try {
    localStorage.setItem(PLAYBACK_MODE_KEY, mode);
  } catch (error) {
    console.error("Could not save playback mode:", error);
  }
  updatePlaybackModeUi();
  closeShuffleMenu();
  const labels = {
    sequential: "Urutan lagu aktif",
    shuffle: "Urutan acak aktif",
    repeat: "Pengulangan lagu aktif",
    smart: "Smart Shuffle aktif"
  };
  showToast(labels[mode]);
}

function closeShuffleMenu() {
  document.querySelector("#shuffle-menu").hidden = true;
  document.querySelector("#shuffle-button").setAttribute("aria-expanded", "false");
}

function setEqualizerPreset(preset) {
  const gains = EQUALIZER_PRESETS[preset];
  if (gains) updateEqualizer(gains, preset);
}

function setAudioStatsOpen(isOpen) {
  statsPanel.hidden = !isOpen;
  equalizerPanel.hidden = true;
}

function closePlayingToolsMenu() {
  playingToolsMenu.hidden = true;
  playingToolsButton.setAttribute("aria-expanded", "false");
}

function setPlayingToolsVisible(isVisible) {
  playingToolsButton.hidden = !isVisible;
  if (!isVisible) {
    closePlayingToolsMenu();
    if (document.querySelector(".playing-tools").contains(document.activeElement)) {
      playButton.focus();
    }
  }
}

function showPlayingTool(tool) {
  closePlayingToolsMenu();
  statsPanel.hidden = tool !== "statistics";
  equalizerPanel.hidden = tool !== "equalizer";
}

function drawWaveform(timestamp = 0) {
  const context = waveformCanvas.getContext("2d");
  const bounds = waveformCanvas.getBoundingClientRect();
  if (!context || bounds.width === 0 || bounds.height === 0) return;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const canvasWidth = Math.round(bounds.width * pixelRatio);
  const canvasHeight = Math.round(bounds.height * pixelRatio);
  if (waveformCanvas.width !== canvasWidth || waveformCanvas.height !== canvasHeight) {
    waveformCanvas.width = canvasWidth;
    waveformCanvas.height = canvasHeight;
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const barCount = 57;
  const centerY = bounds.height / 2;
  const maxBarHeight = bounds.height * 0.43;
  const gap = bounds.width / barCount;
  const lineWidth = Math.max(1.5, Math.min(3, gap * 0.28));
  const gradient = context.createLinearGradient(0, 0, bounds.width, 0);
  gradient.addColorStop(0, "#88ad48");
  gradient.addColorStop(0.48, "#d0f58a");
  gradient.addColorStop(1, "#93bb52");
  context.strokeStyle = gradient;
  context.lineWidth = lineWidth;
  context.lineCap = "round";

  if (audioAnalyser) {
    waveformFrequencies = waveformFrequencies || new Uint8Array(audioAnalyser.frequencyBinCount);
    audioAnalyser.getByteFrequencyData(waveformFrequencies);
  }

  for (let index = 0; index < barCount; index += 1) {
    const position = index / (barCount - 1);
    const peakOne = Math.exp(-Math.pow((position - 0.23) / 0.14, 2)) * 0.48;
    const peakTwo = Math.exp(-Math.pow((position - 0.49) / 0.075, 2)) * 0.78;
    const peakThree = Math.exp(-Math.pow((position - 0.78) / 0.13, 2)) * 0.42;
    const envelope = Math.min(1, 0.11 + peakOne + peakTwo + peakThree);
    const frequencyIndex = waveformFrequencies
      ? Math.min(waveformFrequencies.length - 1, Math.floor(position * waveformFrequencies.length * 0.7))
      : 0;
    const audioLevel = waveformFrequencies
      ? waveformFrequencies[frequencyIndex] / 255
      : 0;
    const fallbackPulse = audio.paused
      ? 0
      : (Math.sin(timestamp / 175 + index * 0.34) + 1) * 0.12;
    const height = Math.max(5, maxBarHeight * envelope * (0.62 + audioLevel * 0.75 + fallbackPulse));
    const x = gap * index + gap / 2;
    context.beginPath();
    context.moveTo(x, centerY - height);
    context.lineTo(x, centerY + height);
    context.stroke();
  }
}

function animateWaveform(timestamp) {
  if (!isNowPlayingOpen) {
    waveformFrame = null;
    return;
  }
  drawWaveform(timestamp - waveformStartedAt);
  if (!audio.paused) {
    waveformFrame = window.requestAnimationFrame(animateWaveform);
  } else {
    waveformFrame = null;
  }
}

function startWaveform() {
  if (waveformFrame !== null || !isNowPlayingOpen) return;
  waveformStartedAt = performance.now();
  waveformFrame = window.requestAnimationFrame(animateWaveform);
}

function stopWaveform() {
  if (waveformFrame !== null) {
    window.cancelAnimationFrame(waveformFrame);
    waveformFrame = null;
  }
  drawWaveform();
}

async function connectAudioVisualizer() {
  if (audioAnalyser) {
    if (audioContext.state === "suspended") await audioContext.resume();
    return;
  }
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;

  let context;
  let source;
  try {
    context = new AudioContextConstructor();
    source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    const filterDefinitions = [
      { type: "lowshelf", frequency: 60 },
      { type: "peaking", frequency: 230, q: 1 },
      { type: "peaking", frequency: 910, q: 1 },
      { type: "peaking", frequency: 3600, q: 1 },
      { type: "highshelf", frequency: 14000 }
    ];
    const filters = filterDefinitions.map((definition, index) => {
      const filter = context.createBiquadFilter();
      filter.type = definition.type;
      filter.frequency.value = definition.frequency;
      if (definition.q) filter.Q.value = definition.q;
      filter.gain.value = equalizerGains[index];
      return filter;
    });
    const bass = context.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 110;
    bass.gain.value = (bassValue / 100) * 12;

    const convolver = context.createConvolver();
    convolver.normalize = false;
    convolver.buffer = createSurroundImpulse(context);
    const dryGain = context.createGain();
    const wetGain = context.createGain();
    const panner = context.createStereoPanner();
    dryGain.gain.value = 1 - (surroundValue / 100) * 0.12;
    wetGain.gain.value = (surroundValue / 100) * 0.32;
    panner.pan.value = balanceValue / 100;

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(filters[0]);
    filters.forEach((filter, index) => {
      const nextNode = filters[index + 1] || bass;
      filter.connect(nextNode);
    });
    bass.connect(dryGain);
    bass.connect(convolver);
    convolver.connect(wetGain);
    dryGain.connect(panner);
    wetGain.connect(panner);
    panner.connect(analyser);
    analyser.connect(context.destination);
    audioContext = context;
    audioAnalyser = analyser;
    equalizerFilters = filters;
    bassFilter = bass;
    balancePanner = panner;
    surroundDryGain = dryGain;
    surroundWetGain = wetGain;
    waveformFrequencies = new Uint8Array(analyser.frequencyBinCount);
  } catch (error) {
    if (source && context) source.connect(context.destination);
    if (context) await context.close();
    console.error("Audio visualizer unavailable:", error);
    audioContext = null;
    audioAnalyser = null;
    waveformFrequencies = null;
    equalizerFilters = [];
    bassFilter = null;
    balancePanner = null;
    surroundDryGain = null;
    surroundWetGain = null;
    return;
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (error) {
      console.error("Audio visualizer could not resume:", error);
    }
  }
}

function createSurroundImpulse(context) {
  const sampleRate = context.sampleRate;
  const reflections = [0.018, 0.033, 0.051, 0.074, 0.104, 0.143, 0.19, 0.24];
  const reflectionLevels = [0.3, 0.23, 0.17, 0.13, 0.09, 0.065, 0.045, 0.025];
  const buffer = context.createBuffer(2, Math.ceil(sampleRate * 0.28), sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const impulse = buffer.getChannelData(channel);
    impulse[0] = 0.7;
    reflections.forEach((reflection, index) => {
      const stereoOffset = channel === 0 ? 0 : 0.006;
      const sampleIndex = Math.round((reflection + stereoOffset) * sampleRate);
      if (sampleIndex < impulse.length) {
        impulse[sampleIndex] = reflectionLevels[index] * (channel === 0 ? 1 : -0.82);
      }
    });
  }
  return buffer;
}

function openNowPlayingScreen() {
  if (!isNowPlayingOpen) {
    const currentState = history.state && typeof history.state === "object"
      ? history.state
      : {};
    history.pushState({ ...currentState, senadaNowPlaying: true }, "", "#now-playing");
    isNowPlayingOpen = true;
  }
  nowPlayingScreen.hidden = false;
  appShell.classList.add("now-playing-open");
  drawWaveform();
  if (!audio.paused) startWaveform();
}

function closeNowPlayingScreen(fromHistory = false) {
  if (!isNowPlayingOpen) return;
  if (!fromHistory && history.state && history.state.senadaNowPlaying) {
    history.back();
    return;
  }
  isNowPlayingOpen = false;
  nowPlayingScreen.hidden = true;
  appShell.classList.remove("now-playing-open");
  stopWaveform();
}

function titleFromFilename(filename) {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;
}

function getObjectUrl(track) {
  if (!objectUrls.has(track.id)) {
    objectUrls.set(track.id, URL.createObjectURL(track.file));
  }
  return objectUrls.get(track.id);
}

function createTrackRow(track, options = {}) {
  const row = document.createElement("article");
  row.className = "track-row";
  row.dataset.trackId = track.id;
  row.innerHTML = `
    <button class="track-main" type="button" aria-label="Putar ${escapeHtml(track.title)}">
      <span class="track-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 17V5l10-2v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="6.5" cy="18" rx="3" ry="2" stroke="currentColor" stroke-width="1.6" transform="rotate(-18 6.5 18)"/><ellipse cx="16.5" cy="15" rx="3" ry="2" stroke="currentColor" stroke-width="1.6" transform="rotate(-18 16.5 15)"/></svg>
      </span>
      <span class="track-text">
        <span class="track-name">${escapeHtml(track.title)}</span>
        <span class="track-meta">${formatSize(track.size)}</span>
      </span>
    </button>
    <span class="track-duration" aria-label="Durasi">${track.duration ? formatTime(track.duration) : "--:--"}</span>
    <button class="remove-button" type="button" aria-label="Hapus ${escapeHtml(track.title)}">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-.8 12H6.8L6 7m4 4v5m4-5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  row.querySelector(".track-main").addEventListener("click", options.onPlay || (() => playTrack(track)));
  const removeButton = row.querySelector(".remove-button");
  if (options.onRemove) {
    removeButton.setAttribute("aria-label", options.removeLabel);
    removeButton.addEventListener("click", options.onRemove);
  } else if (options.hideRemove) {
    removeButton.remove();
    row.classList.add("without-remove");
  } else {
    removeButton.addEventListener("click", () => removeTrack(track));
  }
  return row;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function renderTracks() {
  const query = document.querySelector("#search-input").value.trim().toLocaleLowerCase();
  const visibleTracks = tracks.filter((track) => track.title.toLocaleLowerCase().includes(query));
  trackList.querySelectorAll(".track-row").forEach((row) => row.remove());
  trackList.querySelector(".search-empty")?.remove();
  emptyState.hidden = tracks.length > 0;
  document.querySelector("#track-count").textContent = `${tracks.length} lagu`;

  if (tracks.length > 0 && visibleTracks.length === 0) {
    const noResults = document.createElement("div");
    noResults.className = "empty-state search-empty";
    noResults.innerHTML = "<h3>Lagu tidak ditemukan</h3><p>Coba kata kunci yang berbeda.</p>";
    trackList.append(noResults);
  } else {
    visibleTracks.forEach((track) => {
      const row = createTrackRow(track);
      row.classList.toggle("is-playing", track.id === currentTrackId);
      trackList.append(row);
    });
  }
}

function renderPlaylists() {
  playlistGrid.replaceChildren();
  document.querySelector("#playlist-count").textContent = `${playlists.length} playlist`;
  if (playlists.length === 0) {
    selectedPlaylistId = null;
    playlistDetail.hidden = true;
    const empty = document.createElement("div");
    empty.className = "playlist-empty";
    empty.textContent = "Playlist buatanmu akan muncul di sini.";
    playlistGrid.append(empty);
    return;
  }

  if (!playlists.some((playlist) => playlist.id === selectedPlaylistId)) {
    selectedPlaylistId = playlists[0].id;
  }
  playlists.forEach((playlist) => {
    const card = document.createElement("button");
    card.className = "playlist-card";
    card.type = "button";
    card.setAttribute("aria-pressed", String(playlist.id === selectedPlaylistId));
    card.innerHTML = `
      <span class="playlist-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 17V5l10-2v12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="6.5" cy="18" rx="3" ry="2" stroke="currentColor" stroke-width="1.7" transform="rotate(-18 6.5 18)"/><ellipse cx="16.5" cy="15" rx="3" ry="2" stroke="currentColor" stroke-width="1.7" transform="rotate(-18 16.5 15)"/></svg>
      </span>
      <span class="playlist-card-copy">
        <span class="playlist-card-name">${escapeHtml(playlist.name)}</span>
        <span class="playlist-card-count">${playlist.trackIds.length} lagu</span>
      </span>
      <svg class="playlist-card-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    card.addEventListener("click", () => {
      selectedPlaylistId = playlist.id;
      renderAll();
    });
    playlistGrid.append(card);
  });
  renderSelectedPlaylist();
}

function renderSelectedPlaylist() {
  const playlist = playlists.find((item) => item.id === selectedPlaylistId);
  playlistDetail.hidden = !playlist;
  if (!playlist) return;

  document.querySelector("#selected-playlist-name").textContent = playlist.name;
  const playlistTracks = playlist.trackIds
    .map((trackId) => tracks.find((track) => track.id === trackId))
    .filter(Boolean);
  document.querySelector("#selected-playlist-count").textContent = `${playlistTracks.length} lagu`;
  playlistTrackList.replaceChildren();

  if (playlistTracks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state playlist-track-empty";
    empty.innerHTML = "<h3>Playlist ini masih kosong</h3><p>Tambahkan lagu dari koleksi musikmu.</p>";
    playlistTrackList.append(empty);
    return;
  }

  playlistTracks.forEach((track) => {
    const row = createTrackRow(track, {
      onPlay: () => playTrack(track, playlist.id),
      onRemove: () => removeTrackFromPlaylist(playlist, track),
      removeLabel: `Hapus ${track.title} dari playlist`
    });
    row.classList.toggle("is-playing", track.id === currentTrackId);
    playlistTrackList.append(row);
  });
}

function renderRecentlyPlayed() {
  recentTrackList.replaceChildren();
  const recentTracks = recentHistory
    .slice()
    .sort((a, b) => b.playedAt - a.playedAt)
    .map((entry) => tracks.find((track) => track.id === entry.trackId))
    .filter(Boolean)
    .slice(0, 5);

  if (recentTracks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state recent-empty";
    empty.innerHTML = "<h3>Belum ada lagu diputar</h3><p>Lagu yang kamu dengarkan akan muncul di sini.</p>";
    recentTrackList.append(empty);
    return;
  }

  recentTracks.forEach((track) => {
    const row = createTrackRow(track, { hideRemove: true });
    row.classList.toggle("is-playing", track.id === currentTrackId);
    recentTrackList.append(row);
  });
}

function renderAll() {
  renderTracks();
  renderPlaylists();
  renderRecentlyPlayed();
}

async function loadLibrary() {
  const transaction = database.transaction(["tracks", "playlists", "recentlyPlayed", "syncMarkers"], "readonly");
  const done = transactionDone(transaction);
  const [storedTracks, storedPlaylists, storedHistory, storedMarkers] = await Promise.all([
    requestResult(transaction.objectStore("tracks").getAll()),
    requestResult(transaction.objectStore("playlists").getAll()),
    requestResult(transaction.objectStore("recentlyPlayed").getAll()),
    requestResult(transaction.objectStore("syncMarkers").getAll()),
    done
  ]);
  tracks = storedTracks.sort((a, b) => b.addedAt - a.addedAt);
  playlists = storedPlaylists.sort((a, b) => b.createdAt - a.createdAt);
  recentHistory = storedHistory;
  syncMarkers = storedMarkers;
  renderAll();
}

async function saveFiles(files) {
  const audioFiles = Array.from(files).filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(file.name));
  if (audioFiles.length === 0) {
    showToast("Tidak ada file audio yang bisa ditambahkan.", true);
    return;
  }

  const transaction = database.transaction("tracks", "readwrite");
  const store = transaction.objectStore("tracks");
  const addedTracks = audioFiles.map((file) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: titleFromFilename(file.name),
    file,
    size: file.size,
    duration: 0,
    addedAt: Date.now(),
    updatedAt: Date.now()
  }));
  addedTracks.forEach((track) => store.add(track));
  await transactionDone(transaction);
  tracks = [...addedTracks, ...tracks];
  renderAll();
  showToast(`${addedTracks.length} lagu berhasil disimpan di perangkat.`);

  if (navigator.storage && navigator.storage.persist) {
    try {
      const persisted = await navigator.storage.persist();
      if (!persisted) {
        showToast("Lagu tersimpan, tetapi browser dapat menghapus data jika ruang perangkat hampir penuh.");
      }
    } catch (error) {
      console.error("Persistent storage request failed:", error);
      showToast("Lagu tersimpan, tetapi status penyimpanan permanen tidak dapat dipastikan.");
    }
  }
}

async function createPlaylist(event) {
  event.preventDefault();
  const nameInput = document.querySelector("#playlist-name-input");
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }

  const playlist = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    trackIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  try {
    const transaction = database.transaction("playlists", "readwrite");
    transaction.objectStore("playlists").add(playlist);
    await transactionDone(transaction);
    playlists = [playlist, ...playlists];
    selectedPlaylistId = playlist.id;
    document.querySelector("#create-playlist-dialog").close();
    document.querySelector("#create-playlist-form").reset();
    renderAll();
    showToast(`Playlist “${name}” berhasil dibuat.`);
  } catch (error) {
    showToast(`Playlist gagal dibuat: ${error.message}`, true);
  }
}

function openAddTracksDialog() {
  if (tracks.length === 0) {
    showToast("Unggah musik terlebih dahulu sebelum menambahkan lagu.");
    return;
  }

  const playlist = playlists.find((item) => item.id === selectedPlaylistId);
  if (!playlist) return;
  const options = document.querySelector("#playlist-song-options");
  options.replaceChildren();
  tracks.forEach((track) => {
    const label = document.createElement("label");
    label.className = "track-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = track.id;
    checkbox.checked = playlist.trackIds.includes(track.id);
    const text = document.createElement("span");
    text.className = "track-option-copy";
    const title = document.createElement("span");
    title.className = "track-option-title";
    title.textContent = track.title;
    const size = document.createElement("span");
    size.className = "track-option-size";
    size.textContent = formatSize(track.size);
    text.append(title, size);
    label.append(checkbox, text);
    options.append(label);
  });
  document.querySelector("#add-tracks-dialog").showModal();
}

async function savePlaylistTracks(event) {
  event.preventDefault();
  const playlist = playlists.find((item) => item.id === selectedPlaylistId);
  if (!playlist) return;
  const selectedIds = Array.from(document.querySelectorAll("#playlist-song-options input:checked"))
    .map((checkbox) => checkbox.value)
    .filter((id) => tracks.some((track) => track.id === id));
  const updatedPlaylist = { ...playlist, trackIds: selectedIds, updatedAt: Date.now() };

  try {
    const transaction = database.transaction("playlists", "readwrite");
    transaction.objectStore("playlists").put(updatedPlaylist);
    await transactionDone(transaction);
    playlists = playlists.map((item) => item.id === updatedPlaylist.id ? updatedPlaylist : item);
    document.querySelector("#add-tracks-dialog").close();
    renderAll();
    showToast(`${selectedIds.length} lagu disimpan di “${playlist.name}”.`);
  } catch (error) {
    showToast(`Isi playlist gagal disimpan: ${error.message}`, true);
  }
}

async function removeTrackFromPlaylist(playlist, track) {
  const updatedPlaylist = {
    ...playlist,
    trackIds: playlist.trackIds.filter((trackId) => trackId !== track.id),
    updatedAt: Date.now()
  };
  try {
    const transaction = database.transaction("playlists", "readwrite");
    transaction.objectStore("playlists").put(updatedPlaylist);
    await transactionDone(transaction);
    playlists = playlists.map((item) => item.id === playlist.id ? updatedPlaylist : item);
    if (playbackPlaylistId === playlist.id && currentTrackId === track.id) {
      playbackPlaylistId = null;
    }
    renderAll();
    showToast(`“${track.title}” dihapus dari playlist.`);
  } catch (error) {
    showToast(`Lagu gagal dihapus dari playlist: ${error.message}`, true);
  }
}

async function deletePlaylist() {
  const playlist = playlists.find((item) => item.id === selectedPlaylistId);
  if (!playlist || !window.confirm(`Hapus playlist “${playlist.name}”? Lagu di perpustakaan tidak akan dihapus.`)) return;
  try {
    const marker = {
      key: `playlist:${playlist.id}`,
      type: "playlist",
      id: playlist.id,
      deletedAt: Date.now()
    };
    const transaction = database.transaction(["playlists", "syncMarkers"], "readwrite");
    transaction.objectStore("playlists").delete(playlist.id);
    transaction.objectStore("syncMarkers").put(marker);
    await transactionDone(transaction);
    playlists = playlists.filter((item) => item.id !== playlist.id);
    syncMarkers = [...syncMarkers.filter((item) => item.key !== marker.key), marker];
    if (playbackPlaylistId === playlist.id) playbackPlaylistId = null;
    selectedPlaylistId = playlists.length > 0 ? playlists[0].id : null;
    renderAll();
    showToast(`Playlist “${playlist.name}” dihapus.`);
  } catch (error) {
    showToast(`Playlist gagal dihapus: ${error.message}`, true);
  }
}

async function recordRecentlyPlayed(track) {
  if (!tracks.some((item) => item.id === track.id)) return;
  const entry = { trackId: track.id, playedAt: Date.now() };
  try {
    const transaction = database.transaction("recentlyPlayed", "readwrite");
    transaction.objectStore("recentlyPlayed").put(entry);
    await transactionDone(transaction);
    recentHistory = recentHistory.filter((item) => item.trackId !== track.id);
    recentHistory.push(entry);
    renderRecentlyPlayed();
  } catch (error) {
    showToast(`Lagu diputar, tetapi riwayat gagal disimpan: ${error.message}`, true);
  }
}

function playTrack(track, playlistId = null) {
  currentTrackId = track.id;
  if (playbackMode === "smart") {
    smartShuffleHistory = smartShuffleHistory.filter((trackId) => trackId !== track.id);
    smartShuffleHistory.push(track.id);
  }
  playbackPlaylistId = playlistId;
  playerBar.hidden = false;
  document.querySelector("#now-playing-title").textContent = track.title;
  updateAudioStats(track);
  audio.src = getObjectUrl(track);
  audio.play().then(async () => {
    document.body.classList.add("is-playing-audio");
    openNowPlayingScreen();
    await connectAudioVisualizer();
    startWaveform();
    await recordRecentlyPlayed(track);
    renderAll();
  }).catch((error) => {
    document.body.classList.remove("is-playing-audio");
    showToast(`Lagu tidak dapat diputar: ${error.message}`, true);
  });
  renderAll();
}

function playAdjacentTrack(direction) {
  const playlist = playlists.find((item) => item.id === playbackPlaylistId);
  const queue = playlist
    ? playlist.trackIds.map((trackId) => tracks.find((track) => track.id === trackId)).filter(Boolean)
    : tracks;
  if (queue.length === 0) return;
  if (playbackMode === "repeat") {
    const currentTrack = queue.find((track) => track.id === currentTrackId);
    if (currentTrack) playTrack(currentTrack, playlist ? playlist.id : null);
    return;
  }
  const currentIndex = queue.findIndex((track) => track.id === currentTrackId);
  let nextIndex;
  if (playbackMode === "shuffle" || playbackMode === "smart") {
    let candidates = queue
      .map((track, index) => ({ track, index }))
      .filter((item) => item.track.id !== currentTrackId);
    if (playbackMode === "smart") {
      const unplayedCandidates = candidates.filter((item) => !smartShuffleHistory.includes(item.track.id));
      if (unplayedCandidates.length > 0) candidates = unplayedCandidates;
    }
    if (candidates.length === 0) {
      nextIndex = currentIndex < 0 ? 0 : currentIndex;
    } else {
      nextIndex = candidates[Math.floor(Math.random() * candidates.length)].index;
    }
  } else {
    nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + queue.length) % queue.length;
  }
  playTrack(queue[nextIndex], playlist ? playlist.id : null);
}

function handleTrackEnded() {
  const playlist = playlists.find((item) => item.id === playbackPlaylistId);
  const queueLength = playlist ? playlist.trackIds.length : tracks.length;
  if (playbackMode === "repeat") {
    playAdjacentTrack(1);
    return;
  }
  if (queueLength > 1) {
    playAdjacentTrack(1);
  } else {
    setPlayingToolsVisible(false);
    document.body.classList.remove("is-playing-audio");
  }
}

async function removeTrack(track) {
  try {
    const updatedPlaylists = playlists
      .filter((playlist) => playlist.trackIds.includes(track.id))
      .map((playlist) => ({
        ...playlist,
        trackIds: playlist.trackIds.filter((trackId) => trackId !== track.id)
      }));
    const marker = {
      key: `track:${track.id}`,
      type: "track",
      id: track.id,
      deletedAt: Date.now()
    };
    const transaction = database.transaction(["tracks", "playlists", "recentlyPlayed", "syncMarkers"], "readwrite");
    transaction.objectStore("tracks").delete(track.id);
    transaction.objectStore("recentlyPlayed").delete(track.id);
    transaction.objectStore("syncMarkers").put(marker);
    updatedPlaylists.forEach((playlist) => transaction.objectStore("playlists").put(playlist));
    await transactionDone(transaction);
    tracks = tracks.filter((item) => item.id !== track.id);
    playlists = playlists.map((playlist) => updatedPlaylists.find((item) => item.id === playlist.id) || playlist);
    recentHistory = recentHistory.filter((item) => item.trackId !== track.id);
    syncMarkers = [...syncMarkers.filter((item) => item.key !== marker.key), marker];
    const objectUrl = objectUrls.get(track.id);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(track.id);
    }
    if (currentTrackId === track.id) {
      audio.pause();
      audio.removeAttribute("src");
      currentTrackId = null;
      playbackPlaylistId = null;
      playerBar.hidden = true;
      document.body.classList.remove("is-playing-audio");
      closeNowPlayingScreen();
    }
    renderAll();
    showToast(`“${track.title}” dihapus dari perangkat.`);
  } catch (error) {
    showToast(`Lagu gagal dihapus: ${error.message}`, true);
  }
}

function getLocalSyncState() {
  return {
    tracks: tracks.slice(),
    playlists: playlists.slice(),
    recentHistory: recentHistory.slice(),
    syncMarkers: syncMarkers.slice()
  };
}

function createBackupBlob(state) {
  const fileParts = [];
  let offset = 0;
  const trackMetadata = state.tracks.map((track) => {
    const file = track.file;
    const fileName = file.name || track.fileName || `${track.title}.audio`;
    const byteLength = file.size;
    const metadata = {
      ...track,
      file: undefined,
      fileName,
      mimeType: file.type || track.mimeType || "application/octet-stream",
      byteLength,
      fileOffset: offset
    };
    fileParts.push(file);
    offset += byteLength;
    return metadata;
  });
  const metadata = JSON.stringify({
    version: 1,
    tracks: trackMetadata,
    playlists: state.playlists,
    recentHistory: state.recentHistory,
    syncMarkers: state.syncMarkers
  });
  const metadataBytes = new TextEncoder().encode(metadata);
  const metadataLength = new Uint8Array(4);
  new DataView(metadataLength.buffer).setUint32(0, metadataBytes.byteLength, false);
  return new Blob([BACKUP_MAGIC, metadataLength, metadataBytes, ...fileParts], {
    type: "application/octet-stream"
  });
}

async function parseBackupBlob(blob) {
  if (blob.size < 12) throw new Error("Cadangan Google Drive tidak valid.");
  const prefix = await blob.slice(0, 12).arrayBuffer();
  const prefixBytes = new Uint8Array(prefix);
  if (new TextDecoder().decode(prefixBytes.slice(0, 8)) !== BACKUP_MAGIC) {
    throw new Error("Format cadangan Google Drive tidak dikenal.");
  }
  const metadataLength = new DataView(prefix).getUint32(8, false);
  const dataStart = 12 + metadataLength;
  if (metadataLength === 0 || dataStart > blob.size) {
    throw new Error("Cadangan Google Drive rusak atau tidak lengkap.");
  }

  const metadata = JSON.parse(await blob.slice(12, dataStart).text());
  if (metadata.version !== 1 || !Array.isArray(metadata.tracks)) {
    throw new Error("Versi cadangan Google Drive tidak didukung.");
  }
  const restoredTracks = metadata.tracks.map((track) => {
    const start = dataStart + track.fileOffset;
    const end = start + track.byteLength;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < dataStart || end > blob.size) {
      throw new Error(`Data lagu “${track.title}” di cadangan tidak valid.`);
    }
    const fileBlob = blob.slice(start, end, track.mimeType);
    return {
      ...track,
      file: new File([fileBlob], track.fileName || `${track.title}.audio`, {
        type: track.mimeType || "application/octet-stream"
      })
    };
  });
  return {
    tracks: restoredTracks,
    playlists: Array.isArray(metadata.playlists) ? metadata.playlists : [],
    recentHistory: Array.isArray(metadata.recentHistory) ? metadata.recentHistory : [],
    syncMarkers: Array.isArray(metadata.syncMarkers) ? metadata.syncMarkers : []
  };
}

function recordUpdatedAt(record) {
  return record.updatedAt || record.addedAt || record.createdAt || 0;
}

function latestById(records, getTimestamp) {
  const result = new Map();
  records.forEach((record) => {
    const existing = result.get(record.id);
    if (!existing || getTimestamp(record) >= getTimestamp(existing)) {
      result.set(record.id, record);
    }
  });
  return result;
}

function mergeSyncStates(localState, remoteState) {
  const markersByKey = new Map();
  [...localState.syncMarkers, ...remoteState.syncMarkers].forEach((marker) => {
    const existing = markersByKey.get(marker.key);
    if (!existing || marker.deletedAt > existing.deletedAt) {
      markersByKey.set(marker.key, marker);
    }
  });
  const mergedMarkers = Array.from(markersByKey.values());
  const latestTrackRecords = latestById(
    [...localState.tracks, ...remoteState.tracks],
    recordUpdatedAt
  );
  const trackDeletions = new Map(mergedMarkers
    .filter((marker) => marker.type === "track")
    .map((marker) => [marker.id, marker.deletedAt]));
  const mergedTracks = Array.from(latestTrackRecords.values())
    .filter((track) => !trackDeletions.has(track.id) || trackDeletions.get(track.id) < recordUpdatedAt(track));
  const survivingTrackIds = new Set(mergedTracks.map((track) => track.id));

  const latestPlaylistRecords = latestById(
    [...localState.playlists, ...remoteState.playlists],
    recordUpdatedAt
  );
  const playlistDeletions = new Map(mergedMarkers
    .filter((marker) => marker.type === "playlist")
    .map((marker) => [marker.id, marker.deletedAt]));
  const mergedPlaylists = Array.from(latestPlaylistRecords.values())
    .filter((playlist) => !playlistDeletions.has(playlist.id) || playlistDeletions.get(playlist.id) < recordUpdatedAt(playlist))
    .map((playlist) => ({
      ...playlist,
      trackIds: playlist.trackIds.filter((trackId) => survivingTrackIds.has(trackId))
    }));

  const historyByTrack = new Map();
  [...localState.recentHistory, ...remoteState.recentHistory].forEach((entry) => {
    const existing = historyByTrack.get(entry.trackId);
    if (survivingTrackIds.has(entry.trackId) && (!existing || entry.playedAt > existing.playedAt)) {
      historyByTrack.set(entry.trackId, entry);
    }
  });
  return {
    tracks: mergedTracks,
    playlists: mergedPlaylists,
    recentHistory: Array.from(historyByTrack.values()),
    syncMarkers: mergedMarkers
  };
}

async function saveSyncState(state) {
  const transaction = database.transaction(
    ["tracks", "playlists", "recentlyPlayed", "syncMarkers"],
    "readwrite"
  );
  const stores = {
    tracks: transaction.objectStore("tracks"),
    playlists: transaction.objectStore("playlists"),
    recentlyPlayed: transaction.objectStore("recentlyPlayed"),
    syncMarkers: transaction.objectStore("syncMarkers")
  };
  Object.keys(stores).forEach((name) => stores[name].clear());
  state.tracks.forEach((track) => stores.tracks.put(track));
  state.playlists.forEach((playlist) => stores.playlists.put(playlist));
  state.recentHistory.forEach((entry) => stores.recentlyPlayed.put(entry));
  state.syncMarkers.forEach((marker) => stores.syncMarkers.put(marker));
  await transactionDone(transaction);

  tracks = state.tracks.sort((a, b) => b.addedAt - a.addedAt);
  playlists = state.playlists.sort((a, b) => b.createdAt - a.createdAt);
  recentHistory = state.recentHistory;
  syncMarkers = state.syncMarkers;
  if (currentTrackId && !tracks.some((track) => track.id === currentTrackId)) {
    audio.pause();
    audio.removeAttribute("src");
    currentTrackId = null;
    playbackPlaylistId = null;
    playerBar.hidden = true;
    document.body.classList.remove("is-playing-audio");
  }
  renderAll();
}

function getGoogleAccessToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiresAt - 60000) {
    return Promise.resolve(googleAccessToken);
  }
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    return Promise.reject(new Error("Layanan masuk Google belum termuat. Periksa koneksi internet lalu coba lagi."));
  }

  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: window.SENADA_GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error) {
          const error = new Error(`Google menolak akses: ${response.error_description || response.error}`);
          error.googleOAuthCode = response.error;
          reject(error);
          return;
        }
        googleAccessToken = response.access_token;
        googleTokenExpiresAt = Date.now() + (response.expires_in || 3600) * 1000;
        resolve(googleAccessToken);
      },
      error_callback: (error) => reject(new Error(error.message || "Jendela masuk Google tidak dapat dibuka."))
    });
    const request = googleAccountEmail
      ? { login_hint: googleAccountEmail }
      : { prompt: "select_account" };
    tokenClient.requestAccessToken(request);
  });
}

async function getGoogleAccountEmail() {
  const response = await driveFetch("https://www.googleapis.com/oauth2/v3/userinfo");
  const user = await response.json();
  if (!user.email) throw new Error("Google tidak mengembalikan alamat Gmail untuk akun ini.");
  return user.email;
}

async function driveFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${googleAccessToken}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const details = await response.text();
    if (response.status === 401) googleAccessToken = null;
    throw new Error(`Google Drive (${response.status}): ${details.slice(0, 240) || response.statusText}`);
  }
  return response;
}

async function findDriveBackup() {
  const query = encodeURIComponent(
    `name = '${DRIVE_BACKUP_NAME}' and 'appDataFolder' in parents and trashed = false`
  );
  const response = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name,modifiedTime)&pageSize=100`
  );
  const result = await response.json();
  const files = result.files || [];
  files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return files[0] || null;
}

async function downloadDriveBackup(fileId) {
  const response = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
  );
  return parseBackupBlob(await response.blob());
}

async function uploadDriveBackup(fileId, blob) {
  const isUpdate = Boolean(fileId);
  const endpoint = isUpdate
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=id,name`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name";
  const metadata = isUpdate
    ? {}
    : { name: DRIVE_BACKUP_NAME, mimeType: "application/octet-stream", parents: ["appDataFolder"] };
  const startResponse = await driveFetch(endpoint, {
    method: isUpdate ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(blob.size)
    },
    body: JSON.stringify(metadata)
  });
  const uploadUrl = startResponse.headers.get("Location");
  if (!uploadUrl) throw new Error("Google Drive tidak mengembalikan alamat untuk mengunggah cadangan.");
  await driveFetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob
  });
}

async function syncWithGoogleDrive() {
  const button = document.querySelector("#drive-sync-button");
  const label = document.querySelector("#drive-sync-label");
  const hint = document.querySelector("#drive-sync-hint");
  if (driveSyncInProgress) return;
  if (!navigator.onLine) {
    showToast("Hubungkan ke internet untuk menyinkronkan dengan Google Drive.", true);
    return;
  }
  if (!window.SENADA_GOOGLE_CLIENT_ID) {
    showToast("Sinkronisasi Drive belum dikonfigurasi. Ikuti langkah penyiapan Google di README.", true);
    return;
  }

  driveSyncInProgress = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = "Menghubungkan ke Google Drive...";
  try {
    await getGoogleAccessToken();
    const accountEmail = await getGoogleAccountEmail();
    if (googleAccountEmail && googleAccountEmail.toLowerCase() !== accountEmail.toLowerCase()) {
      googleAccessToken = null;
      throw new Error(`Akun yang dipilih adalah ${accountEmail}, tetapi perangkat ini sebelumnya memakai ${googleAccountEmail}. Pilih akun Gmail yang sama agar datanya tidak tercampur.`);
    }
    localStorage.setItem(GOOGLE_ACCOUNT_KEY, accountEmail);
    googleAccountEmail = accountEmail;
    hint.textContent = `Terhubung sebagai ${accountEmail}. Gunakan Gmail ini di perangkat lain.`;
    const backup = await findDriveBackup();
    const remoteState = backup ? await downloadDriveBackup(backup.id) : {
      tracks: [],
      playlists: [],
      recentHistory: [],
      syncMarkers: []
    };
    const mergedState = mergeSyncStates(getLocalSyncState(), remoteState);
    await saveSyncState(mergedState);
    label.textContent = "Mengunggah koleksi...";
    const backupBlob = createBackupBlob(mergedState);
    await uploadDriveBackup(backup && backup.id, backupBlob);
    label.textContent = `Sinkronkan • ${accountEmail}`;
    showToast(`Sinkronisasi selesai: ${tracks.length} lagu dan ${playlists.length} playlist. Koleksi di perangkat ini dan Drive sudah digabung.`);
  } catch (error) {
    label.textContent = googleAccountEmail
      ? `Sinkronkan • ${googleAccountEmail}`
      : "Hubungkan Gmail & sinkronkan";
    if (error.googleOAuthCode === "access_denied") {
      hint.textContent = "Akses Google Drive belum disetujui. Coba lagi dan setujui izin yang diminta.";
    }
    showToast(`Sinkronisasi gagal: ${error.message}`, true);
    console.error("Google Drive sync failed:", error);
  } finally {
    driveSyncInProgress = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function updateConnectionStatus() {
  connectionLabel.textContent = navigator.onLine ? "Siap dipakai offline" : "Mode offline aktif";
  document.querySelector("#connection-status").classList.toggle("is-offline", !navigator.onLine);
}

uploadInput.addEventListener("change", async (event) => {
  try {
    await saveFiles(event.target.files);
  } catch (error) {
    showToast(`Musik gagal disimpan: ${error.message}`, true);
  } finally {
    uploadInput.value = "";
  }
});

document.querySelector("#search-input").addEventListener("input", renderTracks);
document.querySelector("#create-playlist-button").addEventListener("click", () => {
  document.querySelector("#create-playlist-dialog").showModal();
  document.querySelector("#playlist-name-input").focus();
});
document.querySelector("#cancel-create-playlist").addEventListener("click", () => {
  document.querySelector("#create-playlist-dialog").close();
});
document.querySelector("#create-playlist-form").addEventListener("submit", createPlaylist);
document.querySelector("#add-tracks-button").addEventListener("click", openAddTracksDialog);
document.querySelector("#cancel-add-tracks").addEventListener("click", () => {
  document.querySelector("#add-tracks-dialog").close();
});
document.querySelector("#add-tracks-form").addEventListener("submit", savePlaylistTracks);
document.querySelector("#delete-playlist-button").addEventListener("click", deletePlaylist);
document.querySelector("#drive-sync-button").addEventListener("click", syncWithGoogleDrive);
const shuffleButton = document.querySelector("#shuffle-button");
shuffleButton.addEventListener("click", () => {
  const menu = document.querySelector("#shuffle-menu");
  menu.hidden = !menu.hidden;
  shuffleButton.setAttribute("aria-expanded", String(!menu.hidden));
});
document.querySelectorAll("[data-playback-mode]").forEach((option) => {
  option.addEventListener("click", () => setPlaybackMode(option.dataset.playbackMode));
});
document.querySelector(".shuffle-control").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", closeShuffleMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeShuffleMenu();
});
playingToolsButton.addEventListener("click", () => {
  const isOpen = playingToolsMenu.hidden;
  playingToolsMenu.hidden = !isOpen;
  playingToolsButton.setAttribute("aria-expanded", String(isOpen));
});
playingToolsMenu.querySelectorAll("[data-playing-tool]").forEach((option) => {
  option.addEventListener("click", () => showPlayingTool(option.dataset.playingTool));
});
document.querySelector(".playing-tools").addEventListener("click", (event) => {
  event.stopPropagation();
});
document.addEventListener("click", () => closePlayingToolsMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !playingToolsMenu.hidden) {
    closePlayingToolsMenu();
    playingToolsButton.focus();
  }
});
document.querySelector("#equalizer-preset").addEventListener("change", (event) => {
  if (event.target.value !== "custom") setEqualizerPreset(event.target.value);
});
document.querySelectorAll(".equalizer-slider").forEach((slider) => {
  slider.addEventListener("input", () => {
    const gains = Array.from(document.querySelectorAll(".equalizer-slider"))
      .map((band) => Number(band.value));
    updateEqualizer(gains, "custom");
  });
});
document.querySelector("#balance-slider").addEventListener("input", (event) => {
  updateSoundEffects({
    balance: Number(event.target.value),
    surround: surroundValue,
    bass: bassValue
  });
});
document.querySelector("#surround-slider").addEventListener("input", (event) => {
  updateSoundEffects({
    balance: balanceValue,
    surround: Number(event.target.value),
    bass: bassValue
  });
});
document.querySelector("#bass-slider").addEventListener("input", (event) => {
  updateSoundEffects({
    balance: balanceValue,
    surround: surroundValue,
    bass: Number(event.target.value)
  });
});
playButton.addEventListener("click", () => {
  if (audio.paused) {
    audio.play().then(async () => {
      document.body.classList.add("is-playing-audio");
      openNowPlayingScreen();
      await connectAudioVisualizer();
      startWaveform();
    })
      .catch((error) => showToast(`Lagu tidak dapat diputar: ${error.message}`, true));
  } else {
    audio.pause();
  }
});
document.querySelector("#back-to-library").addEventListener("click", () => closeNowPlayingScreen());
document.querySelector("#open-now-playing").addEventListener("click", () => {
  if (currentTrackId) openNowPlayingScreen();
});
document.querySelector("#previous-button").addEventListener("click", () => playAdjacentTrack(-1));
document.querySelector("#next-button").addEventListener("click", () => playAdjacentTrack(1));
document.querySelector("#seek-bar").addEventListener("input", (event) => {
  if (Number.isFinite(audio.duration)) {
    audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  }
});
document.querySelector("#volume-bar").addEventListener("input", (event) => {
  audio.volume = Number(event.target.value);
});
audio.volume = 0.8;
audio.addEventListener("play", () => {
  setPlayingToolsVisible(true);
  document.body.classList.add("is-playing-audio");
  startWaveform();
});
audio.addEventListener("pause", () => {
  setPlayingToolsVisible(false);
  document.body.classList.remove("is-playing-audio");
  stopWaveform();
});
audio.addEventListener("ended", handleTrackEnded);
audio.addEventListener("timeupdate", () => {
  document.querySelector("#current-time").textContent = formatTime(audio.currentTime);
  document.querySelector("#seek-bar").value = audio.duration
    ? Math.round((audio.currentTime / audio.duration) * 1000)
    : 0;
});
audio.addEventListener("loadedmetadata", () => {
  document.querySelector("#duration-time").textContent = formatTime(audio.duration);
  const currentTrack = tracks.find((track) => track.id === currentTrackId);
  if (currentTrack && Number.isFinite(audio.duration)) {
    currentTrack.duration = audio.duration;
    updateAudioStats(currentTrack);
    renderAll();
    const transaction = database.transaction("tracks", "readwrite");
    transaction.objectStore("tracks").put(currentTrack);
    transactionDone(transaction).catch((error) => showToast(`Durasi lagu gagal disimpan: ${error.message}`, true));
  }
});
window.addEventListener("popstate", () => {
  if (isNowPlayingOpen) closeNowPlayingScreen(true);
});
window.addEventListener("resize", () => {
  if (isNowPlayingOpen) drawWaveform();
});
document.querySelector("#close-stats-button").addEventListener("click", () => {
  setAudioStatsOpen(false);
  playingToolsButton.focus();
});
audio.addEventListener("error", () => {
  if (audio.error) showToast("Format file ini tidak didukung oleh browser.", true);
});
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);

async function startApp() {
  updateConnectionStatus();
  loadEqualizerPreferences();
  loadPlaybackMode();
  try {
    database = await openDatabase();
    await loadLibrary();
  } catch (error) {
    showToast(`Penyimpanan tidak dapat dibuka: ${error.message}`, true);
    uploadInput.disabled = true;
  }

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
      if (navigator.onLine) connectionLabel.textContent = "Siap dipakai offline";
    } catch (error) {
      showToast(`Mode offline belum aktif. Buka aplikasi melalui HTTPS untuk menyiapkannya.`, true);
      console.error("Service worker registration failed:", error);
    }
  }
}

startApp();
