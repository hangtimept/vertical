/**
 * JumpLab — Vertical Jump Analyzer
 * Flight-time method: h = g * t² / 8
 */

(() => {
  'use strict';

  const G = 9.80665; // m/s²

  const state = {
    unit: 'metric', // metric = cm, imperial = inches
    audioEnabled: true,
    sensitivity: 15, // motion threshold %

    // session
    jumps: [], // { heightM, flightTime, mode, timestamp }

    // live
    stream: null,
    armed: false,
    phase: 'idle', // idle | armed | airborne | cooldown
    takeoffTime: 0,
    flightTime: 0,
    prevFrame: null,
    baselineEnergy: 0,
    baselineSamples: 0,
    roiRatio: 0.28, // bottom 28% of frame = feet zone
    cooldownUntil: 0,
    lastHeightM: 0,

    // video
    videoReady: false,
    videoFps: 30,
    takeoffT: null,
    landingT: null,
    duration: 0,
  };

  const $ = (s) => document.querySelector(s);
  const screens = {
    splash: $('#splash'),
    live: $('#live'),
    video: $('#video-mode'),
  };

  // ---------- Helpers ----------
  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.remove('active'));
    screens[name].classList.add('active');
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function heightFromFlight(tSec) {
    // h = g * t² / 8  (meters)
    return (G * tSec * tSec) / 8;
  }

  function formatHeight(m) {
    if (state.unit === 'imperial') {
      return (m * 39.3701).toFixed(1);
    }
    return (m * 100).toFixed(1);
  }

  function heightUnit() {
    return state.unit === 'imperial' ? 'in' : 'cm';
  }

  // ---------- Audio ----------
  let audioCtx = null;
  function beep(freq = 880, dur = 0.1, type = 'sine') {
    if (!state.audioEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.18, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }

  // ---------- Persistence ----------
  function loadJumps() {
    try {
      state.jumps = JSON.parse(localStorage.getItem('jl_jumps') || '[]');
    } catch {
      state.jumps = [];
    }
  }

  function saveJumps() {
    localStorage.setItem('jl_jumps', JSON.stringify(state.jumps.slice(0, 100)));
  }

  function addJump(heightM, flightTime, mode) {
    state.jumps.unshift({
      heightM,
      flightTime,
      mode,
      timestamp: Date.now(),
    });
    saveJumps();
    updateSessionUI();
    showToast(heightM, flightTime);
  }

  function bestJump() {
    if (!state.jumps.length) return 0;
    return Math.max(...state.jumps.map((j) => j.heightM));
  }

  function updateSessionUI() {
    const best = bestJump();
    const avg = state.jumps.length
      ? state.jumps.reduce((s, j) => s + j.heightM, 0) / state.jumps.length
      : 0;

    $('#live-count').textContent = state.jumps.length;
    $('#live-best').textContent = best ? formatHeight(best) : '—';
    $('#live-height-unit').textContent = heightUnit();

    $('#hist-count').textContent = state.jumps.length;
    $('#hist-best').textContent = best ? formatHeight(best) + ' ' + heightUnit() : '—';
    $('#hist-avg').textContent = avg ? formatHeight(avg) + ' ' + heightUnit() : '—';

    const list = $('#jump-list');
    list.innerHTML = '';
    if (!state.jumps.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:13px">No jumps recorded yet.</p>';
      return;
    }
    state.jumps.slice(0, 30).forEach((j, i) => {
      const d = new Date(j.timestamp);
      const div = document.createElement('div');
      div.className = 'jump-item';
      div.innerHTML = `
        <div>
          <div class="jh">${formatHeight(j.heightM)} ${heightUnit()}</div>
          <div class="meta">${j.flightTime.toFixed(3)}s · ${j.mode} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div class="meta">#${state.jumps.length - i}</div>
      `;
      list.appendChild(div);
    });
  }

  function showToast(heightM, flightTime) {
    const toast = $('#result-toast');
    $('#toast-height').textContent = formatHeight(heightM);
    toast.querySelector('.toast-label').textContent = heightUnit() + ' vertical';
    $('#toast-flight').textContent = flightTime.toFixed(3) + 's flight';
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2200);
  }

  // ========== LIVE CAMERA MODE ==========
  const liveVideo = $('#live-video');
  const liveOverlay = $('#live-overlay');
  const liveCtx = liveOverlay.getContext('2d', { willReadFrequently: true });

  async function startLiveCamera() {
    try {
      if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      liveVideo.srcObject = state.stream;
      await liveVideo.play();
      state.phase = 'idle';
      state.armed = false;
      state.prevFrame = null;
      state.baselineEnergy = 0;
      state.baselineSamples = 0;
      setStatus('Stand still — then Arm Sensor', '');
      requestAnimationFrame(liveLoop);
    } catch (err) {
      alert('Camera access failed. Use HTTPS or localhost and allow permissions.');
      console.error(err);
    }
  }

  function stopLiveCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    state.armed = false;
    state.phase = 'idle';
  }

  function setStatus(text, cls) {
    const el = $('#live-status');
    el.textContent = text;
    el.className = 'status-badge' + (cls ? ' ' + cls : '');
  }

  /**
   * Motion energy in the bottom ROI (feet zone).
   * Uses grayscale frame difference vs previous frame.
   */
  function computeRoiEnergy(w, h) {
    const roiTop = Math.floor(h * (1 - state.roiRatio));
    const roiH = h - roiTop;
    const step = 3;

    liveCtx.drawImage(liveVideo, 0, 0, w, h);
    let imageData;
    try {
      imageData = liveCtx.getImageData(0, roiTop, w, roiH);
    } catch {
      return 0;
    }
    const data = imageData.data;

    // Build grayscale buffer for ROI
    const gray = new Uint8Array(Math.ceil(w / step) * Math.ceil(roiH / step));
    let gi = 0;
    for (let y = 0; y < roiH; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        gray[gi++] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      }
    }

    let energy = 0;
    if (state.prevFrame && state.prevFrame.length === gray.length) {
      for (let i = 0; i < gray.length; i++) {
        energy += Math.abs(gray[i] - state.prevFrame[i]);
      }
      energy = energy / gray.length; // average absolute difference 0–255
    }
    state.prevFrame = gray;
    return energy;
  }

  function drawLiveOverlay(w, h, energy, threshold) {
    liveCtx.clearRect(0, 0, w, h);

    // ROI band
    const roiTop = Math.floor(h * (1 - state.roiRatio));
    liveCtx.fillStyle = state.phase === 'airborne'
      ? 'rgba(167, 139, 250, 0.12)'
      : 'rgba(52, 211, 153, 0.1)';
    liveCtx.fillRect(0, roiTop, w, h - roiTop);
    liveCtx.strokeStyle = state.phase === 'airborne' ? '#a78bfa' : '#34d399';
    liveCtx.lineWidth = 2;
    liveCtx.setLineDash([6, 4]);
    liveCtx.strokeRect(4, roiTop + 2, w - 8, h - roiTop - 6);
    liveCtx.setLineDash([]);

    // Motion meter (right edge)
    const meterH = 80;
    const meterY = roiTop - meterH - 12;
    const fill = clamp(energy / (threshold * 2.5), 0, 1);
    liveCtx.fillStyle = 'rgba(0,0,0,0.5)';
    liveCtx.fillRect(w - 18, meterY, 10, meterH);
    liveCtx.fillStyle = fill > 0.6 ? '#a78bfa' : '#34d399';
    liveCtx.fillRect(w - 18, meterY + meterH * (1 - fill), 10, meterH * fill);
  }

  let lastLiveFrame = 0;
  function liveLoop(now) {
    if (!screens.live.classList.contains('active') || !liveVideo.videoWidth) {
      requestAnimationFrame(liveLoop);
      return;
    }

    const w = liveVideo.videoWidth;
    const h = liveVideo.videoHeight;
    if (liveOverlay.width !== w || liveOverlay.height !== h) {
      liveOverlay.width = w;
      liveOverlay.height = h;
    }

    // ~30 fps analysis
    if (now - lastLiveFrame < 30) {
      requestAnimationFrame(liveLoop);
      return;
    }
    lastLiveFrame = now;

    const energy = computeRoiEnergy(w, h);
    const threshold = state.sensitivity; // avg abs diff 0-255 scale, typical still ~2-8, motion 15-60+

    // Build baseline while standing still (armed but not jumped)
    if (state.phase === 'armed' && energy < threshold * 0.6) {
      state.baselineEnergy =
        (state.baselineEnergy * state.baselineSamples + energy) / (state.baselineSamples + 1);
      state.baselineSamples++;
    }

    const takeoffThresh = Math.max(threshold, state.baselineEnergy * 3 + 8);
    const landQuiet = Math.max(4, state.baselineEnergy * 1.8 + 3);

    // State machine
    if (state.phase === 'armed') {
      if (energy > takeoffThresh && state.baselineSamples > 8) {
        // TAKEOFF
        state.phase = 'airborne';
        state.takeoffTime = performance.now();
        state.flightTime = 0;
        setStatus('AIRBORNE', 'airborne');
        beep(990, 0.07);
        $('#roi-hint').textContent = 'In the air…';
      }
    } else if (state.phase === 'airborne') {
      const t = (performance.now() - state.takeoffTime) / 1000;
      state.flightTime = t;
      $('#live-flight').textContent = t.toFixed(3);

      // Landing: motion drops and stays low after at least 0.18s flight
      // (ignore very short false detections)
      if (t > 0.18 && energy < landQuiet) {
        // require a couple quiet frames via cooldown pattern
        finishLiveJump(t);
      }

      // Safety: max 2s flight
      if (t > 2.0) {
        finishLiveJump(t);
      }
    } else if (state.phase === 'cooldown') {
      if (performance.now() > state.cooldownUntil) {
        state.phase = 'armed';
        state.baselineSamples = 0;
        state.baselineEnergy = 0;
        state.prevFrame = null;
        setStatus('Ready — jump again', 'armed');
        $('#roi-hint').textContent = 'Keep feet inside the green zone';
      }
    }

    // Live height preview while airborne
    if (state.phase === 'airborne') {
      const hM = heightFromFlight(state.flightTime);
      $('#live-height').textContent = formatHeight(hM);
    }

    drawLiveOverlay(w, h, energy, takeoffThresh);
    requestAnimationFrame(liveLoop);
  }

  function finishLiveJump(t) {
    const heightM = heightFromFlight(t);
    state.lastHeightM = heightM;
    state.flightTime = t;
    state.phase = 'cooldown';
    state.cooldownUntil = performance.now() + 1500;

    $('#live-flight').textContent = t.toFixed(3);
    $('#live-height').textContent = formatHeight(heightM);
    setStatus('LANDED  ' + formatHeight(heightM) + ' ' + heightUnit(), 'landed');
    $('#roi-hint').textContent = 'Nice — arming again in a moment';

    beep(660, 0.12);
    setTimeout(() => beep(880, 0.1), 100);

    addJump(heightM, t, 'live');
  }

  function armLive() {
    if (!state.stream) return;
    if (state.armed && state.phase !== 'idle') {
      // disarm
      state.armed = false;
      state.phase = 'idle';
      state.prevFrame = null;
      $('#arm-label').textContent = 'Arm Sensor';
      setStatus('Stand still — then Arm Sensor', '');
      $('#roi-hint').textContent = 'Keep feet inside the green zone';
      return;
    }
    state.armed = true;
    state.phase = 'armed';
    state.baselineEnergy = 0;
    state.baselineSamples = 0;
    state.prevFrame = null;
    state.flightTime = 0;
    $('#live-flight').textContent = '0.000';
    $('#live-height').textContent = '—';
    $('#arm-label').textContent = 'Disarm';
    setStatus('ARMED — jump when ready', 'armed');
    beep(520, 0.06);
  }

  // ========== VIDEO MODE ==========
  const analysisVideo = $('#analysis-video');
  const videoOverlay = $('#video-overlay');
  const videoCtx = videoOverlay.getContext('2d');

  function loadVideoFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      alert('Please choose a video file.');
      return;
    }
    const url = URL.createObjectURL(file);
    analysisVideo.src = url;
    analysisVideo.onloadedmetadata = () => {
      state.videoReady = true;
      state.duration = analysisVideo.duration;
      state.takeoffT = null;
      state.landingT = null;

      // Estimate FPS
      // HTMLVideoElement doesn't expose fps reliably; default 30, user can override
      state.videoFps = 30;
      // Try to read from requestVideoFrameCallback if available later
      estimateFps();

      $('#drop-zone').classList.add('hidden');
      $('#timeline-panel').hidden = false;
      $('#scrubber').max = Math.floor(state.duration * 1000);
      $('#scrubber').value = 0;
      $('#total-time').textContent = '/ ' + state.duration.toFixed(3) + 's';
      $('#vid-fps').textContent = state.videoFps.toFixed(1);
      $('#fps-input').value = '';
      updateVideoMarks();
      seekTo(0);
    };
  }

  function estimateFps() {
    // Best-effort: many phones record 30 or 60
    // User should override if known
    if (analysisVideo.getVideoPlaybackQuality) {
      // not helpful until playing
    }
    state.videoFps = 30;
  }

  function getEffectiveFps() {
    const override = parseFloat($('#fps-input').value);
    if (override > 0 && override <= 240) return override;
    return state.videoFps;
  }

  function seekTo(t) {
    analysisVideo.currentTime = clamp(t, 0, state.duration || 0);
  }

  function onVideoTimeUpdate() {
    const t = analysisVideo.currentTime;
    $('#scrubber').value = Math.floor(t * 1000);
    $('#current-time').textContent = t.toFixed(3) + 's';
    const fps = getEffectiveFps();
    $('#frame-num').textContent = 'f ' + Math.round(t * fps);
    drawVideoMarkers();
  }

  function drawVideoMarkers() {
    const v = analysisVideo;
    if (!v.videoWidth) return;
    const canvas = videoOverlay;
    const rect = canvas.parentElement.getBoundingClientRect();
    // Match contain sizing
    const va = v.videoWidth / v.videoHeight;
    const ra = rect.width / rect.height;
    let dw, dh, ox, oy;
    if (va > ra) {
      dw = rect.width;
      dh = rect.width / va;
      ox = 0;
      oy = (rect.height - dh) / 2;
    } else {
      dh = rect.height;
      dw = rect.height * va;
      ox = (rect.width - dw) / 2;
      oy = 0;
    }
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    videoCtx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    videoCtx.clearRect(0, 0, rect.width, rect.height);

    // Marker lines at takeoff / landing (visual feedback on timeline is primary)
    // Draw corner badges
    videoCtx.font = '12px Inter, system-ui';
    if (state.takeoffT != null && Math.abs(v.currentTime - state.takeoffT) < 0.05) {
      videoCtx.fillStyle = 'rgba(52, 211, 153, 0.85)';
      videoCtx.fillRect(ox + 8, oy + 8, 90, 28);
      videoCtx.fillStyle = '#000';
      videoCtx.fillText('TAKEOFF', ox + 18, oy + 27);
    }
    if (state.landingT != null && Math.abs(v.currentTime - state.landingT) < 0.05) {
      videoCtx.fillStyle = 'rgba(34, 211, 238, 0.85)';
      videoCtx.fillRect(ox + 8, oy + 8, 90, 28);
      videoCtx.fillStyle = '#000';
      videoCtx.fillText('LANDING', ox + 18, oy + 27);
    }
  }

  function updateVideoMarks() {
    const fps = getEffectiveFps();
    $('#vid-fps').textContent = fps.toFixed(1);

    if (state.takeoffT != null) {
      $('#takeoff-val').textContent = state.takeoffT.toFixed(3) + 's';
      $('#btn-mark-takeoff').classList.add('active-takeoff');
    } else {
      $('#takeoff-val').textContent = '—';
      $('#btn-mark-takeoff').classList.remove('active-takeoff');
    }
    if (state.landingT != null) {
      $('#landing-val').textContent = state.landingT.toFixed(3) + 's';
      $('#btn-mark-landing').classList.add('active-landing');
    } else {
      $('#landing-val').textContent = '—';
      $('#btn-mark-landing').classList.remove('active-landing');
    }

    if (state.takeoffT != null && state.landingT != null && state.landingT > state.takeoffT) {
      const flight = state.landingT - state.takeoffT;
      const heightM = heightFromFlight(flight);
      $('#vid-flight').textContent = flight.toFixed(3) + 's';
      $('#vid-height').textContent = formatHeight(heightM) + ' ' + heightUnit();
      $('#btn-save-video-jump').disabled = false;
    } else {
      $('#vid-flight').textContent = '—';
      $('#vid-height').textContent = '—';
      $('#btn-save-video-jump').disabled = true;
    }
  }

  function frameStep(dir) {
    const fps = getEffectiveFps();
    const dt = 1 / fps;
    seekTo(analysisVideo.currentTime + dir * dt);
  }

  // ---------- Events ----------
  $('#btn-mode-live').addEventListener('click', () => {
    showScreen('live');
    startLiveCamera();
    updateSessionUI();
  });

  $('#btn-mode-video').addEventListener('click', () => {
    showScreen('video');
    stopLiveCamera();
  });

  $('#btn-live-back').addEventListener('click', () => {
    stopLiveCamera();
    showScreen('splash');
  });

  $('#btn-video-back').addEventListener('click', () => {
    analysisVideo.pause();
    analysisVideo.removeAttribute('src');
    state.videoReady = false;
    $('#drop-zone').classList.remove('hidden');
    $('#timeline-panel').hidden = true;
    showScreen('splash');
  });

  $('#btn-live-arm').addEventListener('click', armLive);

  $('#btn-live-reset').addEventListener('click', () => {
    state.phase = state.armed ? 'armed' : 'idle';
    state.flightTime = 0;
    state.baselineSamples = 0;
    state.baselineEnergy = 0;
    state.prevFrame = null;
    $('#live-flight').textContent = '0.000';
    $('#live-height').textContent = '—';
    if (state.armed) setStatus('ARMED — jump when ready', 'armed');
    else setStatus('Stand still — then Arm Sensor', '');
  });

  $('#btn-live-history').addEventListener('click', openDrawer);
  $('#btn-live-settings').addEventListener('click', openDrawer);
  $('#btn-close-drawer').addEventListener('click', () => $('#drawer').classList.add('hidden'));
  $('#drawer').addEventListener('click', (e) => {
    if (e.target === $('#drawer')) $('#drawer').classList.add('hidden');
  });

  function openDrawer() {
    updateSessionUI();
    $('#drawer').classList.remove('hidden');
  }

  // Video file
  const dropZone = $('#drop-zone');
  const fileInput = $('#video-file');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadVideoFile(fileInput.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadVideoFile(e.dataTransfer.files[0]);
  });

  $('#scrubber').addEventListener('input', () => {
    seekTo(parseInt($('#scrubber').value, 10) / 1000);
  });
  analysisVideo.addEventListener('timeupdate', onVideoTimeUpdate);
  analysisVideo.addEventListener('seeked', onVideoTimeUpdate);

  $('#btn-frame-back').addEventListener('click', () => frameStep(-1));
  $('#btn-frame-fwd').addEventListener('click', () => frameStep(1));

  $('#btn-mark-takeoff').addEventListener('click', () => {
    state.takeoffT = analysisVideo.currentTime;
    updateVideoMarks();
    beep(700, 0.05);
  });
  $('#btn-mark-landing').addEventListener('click', () => {
    state.landingT = analysisVideo.currentTime;
    updateVideoMarks();
    beep(900, 0.05);
  });

  $('#fps-input').addEventListener('input', updateVideoMarks);

  $('#btn-save-video-jump').addEventListener('click', () => {
    if (state.takeoffT == null || state.landingT == null) return;
    const flight = state.landingT - state.takeoffT;
    if (flight <= 0) return;
    const heightM = heightFromFlight(flight);
    addJump(heightM, flight, 'video');
    beep(880, 0.1);
  });

  $('#btn-video-help').addEventListener('click', () => {
    alert(
      'Video analysis tips:\n\n' +
        '1. Film from the side so feet are clearly visible.\n' +
        '2. Scrub to the last frame both feet are still on the ground → Set Takeoff.\n' +
        '3. Scrub to the first frame a foot contacts the ground again → Set Landing.\n' +
        '4. Enter the real FPS of the video if known (30, 60, 120, 240).\n' +
        '5. Height = g × t² / 8\n\n' +
        'Higher FPS = more precise flight time.'
    );
  });

  $('#unit-pref').addEventListener('change', (e) => {
    state.unit = e.target.value;
    updateSessionUI();
    updateVideoMarks();
    $('#live-height-unit').textContent = heightUnit();
    if (state.lastHeightM) {
      $('#live-height').textContent = formatHeight(state.lastHeightM);
    }
  });
  $('#audio-enabled').addEventListener('change', (e) => {
    state.audioEnabled = e.target.checked;
  });
  $('#sensitivity').addEventListener('input', (e) => {
    state.sensitivity = parseInt(e.target.value, 10);
  });
  $('#btn-clear-history').addEventListener('click', () => {
    if (confirm('Clear all saved jumps?')) {
      state.jumps = [];
      saveJumps();
      updateSessionUI();
    }
  });

  // Prevent pull-to-refresh on camera screens
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.target.closest('.drawer-body, .timeline-panel')) return;
      if (screens.live.classList.contains('active')) e.preventDefault();
    },
    { passive: false }
  );

  // Init
  loadJumps();
  updateSessionUI();
  showScreen('splash');
})();
