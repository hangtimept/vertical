/**
 * JumpLab — Vertical Jump Analyzer
 * Flight-time method: h = g * t² / 8
 */

(() => {
  'use strict';

  const G = 9.80665; // m/s²

  const state = {
    unit: 'imperial', // default inches
    audioEnabled: true,
    sensitivity: 18, // leave-box sensitivity (slider)
    jumpType: 'stationary', // stationary | dynamic

    // session
    jumps: [], // { heightM, flightTime, mode, timestamp }

    // live
    stream: null,
    armed: false,
    phase: 'idle', // idle | calibrating | armed | airborne | cooldown
    takeoffTime: 0,
    flightTime: 0,
    // Presence detection: compare ROI to "feet present" reference
    feetRef: null,          // Float32 grayscale reference of ROI (feet on ground)
    feetRefReady: false,
    calibSamples: 0,
    calibNeeded: 20,        // frames to average for reference
    presenceDiff: 0,        // current MAD vs reference (0–255 scale)
    emptyStreak: 0,         // consecutive frames ROI looks empty
    presentStreak: 0,       // consecutive frames ROI looks occupied
    roiRatio: 0.30,         // bottom fraction (stationary default)
    roiTopFrac: 0.70,       // start of feet zone (1 - roiRatio)
    cooldownUntil: 0,
    lastHeightM: 0,
    // Thresholds (MAD). Higher sensitivity slider → lower leave threshold
    leaveThresh: 18,
    returnThresh: 12,

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
      state.feetRef = null;
      state.feetRefReady = false;
      state.calibSamples = 0;
      setStatus('Put feet in the green zone, then Arm', '');
      $('#roi-hint').textContent = 'Feet must stay inside the green zone while standing';
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
    state.feetRef = null;
    state.feetRefReady = false;
  }

  function setStatus(text, cls) {
    const el = $('#live-status');
    el.textContent = text;
    el.className = 'status-badge' + (cls ? ' ' + cls : '');
  }

  function updateThresholdsFromSensitivity() {
    // Higher sensitivity slider value = more sensitive = lower leave threshold
    // slider 5–40, map to leaveThresh ~28 down to ~10
    const s = state.sensitivity;
    state.leaveThresh = clamp(32 - s * 0.55, 8, 35);
    state.returnThresh = state.leaveThresh * 0.65;
  }

  /**
   * Grab grayscale ROI sample (downsampled).
   * Returns Float32Array of brightness values.
   */
  function applyJumpType(type) {
    state.jumpType = type;
    document.querySelectorAll('.type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === type);
    });
    if (type === 'dynamic') {
      // Camera farther away: thinner band near the bottom for feet on approach
      state.roiRatio = 0.18;
      state.roiTopFrac = 0.82;
      state.calibNeeded = 24;
      state.leaveThresh = 14;
      $('#roi-hint').textContent = 'Dynamic: stand at jump takeoff spot — feet in the lower green band';
      setStatus('Dynamic mode — place takeoff in the green band', '');
    } else {
      // Stationary: larger bottom zone
      state.roiRatio = 0.30;
      state.roiTopFrac = 0.70;
      state.calibNeeded = 20;
      $('#roi-hint').textContent = 'Stationary: keep both feet inside the green zone';
      setStatus('Put feet in the green zone, then Arm', '');
    }
    // Force re-calib if currently armed
    if (state.armed && state.phase !== 'idle') {
      state.phase = 'calibrating';
      state.feetRef = null;
      state.feetRefReady = false;
      state.calibSamples = 0;
    }
  }

  function sampleRoiGray(w, h) {
    const roiTop = Math.floor(h * state.roiTopFrac);
    const roiH = h - roiTop;
    const step = 3;

    liveCtx.drawImage(liveVideo, 0, 0, w, h);
    let imageData;
    try {
      imageData = liveCtx.getImageData(0, roiTop, w, roiH);
    } catch {
      return null;
    }
    const data = imageData.data;
    const cols = Math.ceil(w / step);
    const rows = Math.ceil(roiH / step);
    const gray = new Float32Array(cols * rows);
    let gi = 0;
    for (let y = 0; y < roiH; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        gray[gi++] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      }
    }
    return gray;
  }

  /**
   * Mean absolute difference between current ROI and feet reference.
   * High diff  = feet left the zone (empty / different background)
   * Low diff   = feet still present (matches reference)
   */
  function presenceDiff(gray) {
    if (!state.feetRef || !gray || gray.length !== state.feetRef.length) return 0;
    let sum = 0;
    for (let i = 0; i < gray.length; i++) {
      sum += Math.abs(gray[i] - state.feetRef[i]);
    }
    return sum / gray.length;
  }

  /**
   * Accumulate reference while feet are on the ground (calibrating).
   */
  function accumulateFeetRef(gray) {
    if (!gray) return;
    if (!state.feetRef || state.feetRef.length !== gray.length) {
      state.feetRef = new Float32Array(gray.length);
      state.calibSamples = 0;
    }
    const n = state.calibSamples;
    for (let i = 0; i < gray.length; i++) {
      state.feetRef[i] = (state.feetRef[i] * n + gray[i]) / (n + 1);
    }
    state.calibSamples = n + 1;
    if (state.calibSamples >= state.calibNeeded) {
      state.feetRefReady = true;
    }
  }

  function drawLiveOverlay(w, h, diff) {
    liveCtx.clearRect(0, 0, w, h);

    const roiTop = Math.floor(h * state.roiTopFrac);
    const airborne = state.phase === 'airborne';
    const calibrating = state.phase === 'calibrating';

    liveCtx.fillStyle = airborne
      ? 'rgba(167, 139, 250, 0.15)'
      : calibrating
        ? 'rgba(251, 191, 36, 0.12)'
        : 'rgba(52, 211, 153, 0.12)';
    liveCtx.fillRect(0, roiTop, w, h - roiTop);

    liveCtx.strokeStyle = airborne ? '#a78bfa' : calibrating ? '#fbbf24' : '#34d399';
    liveCtx.lineWidth = 3;
    liveCtx.setLineDash(airborne ? [] : [8, 5]);
    liveCtx.strokeRect(4, roiTop + 2, w - 8, h - roiTop - 6);
    liveCtx.setLineDash([]);

    // Presence meter (how different from feet-on-ground reference)
    const meterH = 90;
    const meterY = roiTop - meterH - 14;
    const leave = state.leaveThresh || 18;
    const fill = clamp(diff / (leave * 2.2), 0, 1);
    liveCtx.fillStyle = 'rgba(0,0,0,0.55)';
    liveCtx.fillRect(w - 20, meterY, 12, meterH);
    liveCtx.fillStyle = fill > 0.55 ? '#a78bfa' : '#34d399';
    liveCtx.fillRect(w - 20, meterY + meterH * (1 - fill), 12, meterH * fill);

    // Threshold tick
    const tickY = meterY + meterH * (1 - clamp(leave / (leave * 2.2), 0, 1));
    liveCtx.strokeStyle = '#fff';
    liveCtx.lineWidth = 1;
    liveCtx.beginPath();
    liveCtx.moveTo(w - 22, tickY);
    liveCtx.lineTo(w - 6, tickY);
    liveCtx.stroke();

    // Label
    liveCtx.font = '11px Inter, system-ui';
    liveCtx.fillStyle = 'rgba(255,255,255,0.7)';
    liveCtx.fillText(airborne ? 'EMPTY' : 'FEET', w - 52, meterY - 4);
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

    if (now - lastLiveFrame < 28) {
      requestAnimationFrame(liveLoop);
      return;
    }
    lastLiveFrame = now;

    updateThresholdsFromSensitivity();
    const gray = sampleRoiGray(w, h);
    let diff = 0;

    // ----- CALIBRATING: learn what "feet in box" looks like -----
    if (state.phase === 'calibrating') {
      accumulateFeetRef(gray);
      const pct = Math.min(100, Math.round((state.calibSamples / state.calibNeeded) * 100));
      setStatus('Hold still… calibrating feet ' + pct + '%', '');
      $('#roi-hint').textContent = 'Stand still with both feet in the green zone';
      if (state.feetRefReady) {
        state.phase = 'armed';
        state.emptyStreak = 0;
        state.presentStreak = 0;
        setStatus('ARMED — jump when ready', 'armed');
        $('#roi-hint').textContent = 'Timer starts when feet leave the box';
        beep(660, 0.08);
      }
      drawLiveOverlay(w, h, 0);
      requestAnimationFrame(liveLoop);
      return;
    }

    if (state.feetRefReady && gray) {
      diff = presenceDiff(gray);
      state.presenceDiff = diff;
    }

    const leaveT = state.leaveThresh;
    const returnT = state.returnThresh;

    // ----- ARMED: wait for feet to LEAVE the box -----
    if (state.phase === 'armed') {
      if (diff > leaveT) {
        state.emptyStreak++;
        state.presentStreak = 0;
      } else {
        state.emptyStreak = 0;
        state.presentStreak++;
      }
      // Require a few consecutive empty frames to avoid noise
      if (state.emptyStreak >= 3) {
        state.phase = 'airborne';
        state.takeoffTime = performance.now();
        state.flightTime = 0;
        state.presentStreak = 0;
        state.emptyStreak = 0;
        setStatus('AIRBORNE', 'airborne');
        $('#roi-hint').textContent = 'Waiting for feet to return…';
        beep(990, 0.07);
      }
    }

    // ----- AIRBORNE: wait for feet to RETURN to the box -----
    else if (state.phase === 'airborne') {
      const t = (performance.now() - state.takeoffTime) / 1000;
      state.flightTime = t;
      $('#live-flight').textContent = t.toFixed(3);
      $('#live-height').textContent = formatHeight(heightFromFlight(t));

      if (diff < returnT) {
        state.presentStreak++;
        state.emptyStreak = 0;
      } else {
        state.presentStreak = 0;
        state.emptyStreak++;
      }

      // Feet back for a few frames + minimum flight time
      if (t > 0.20 && state.presentStreak >= 3) {
        finishLiveJump(t);
      }
      // Safety cap
      if (t > 2.2) {
        finishLiveJump(t);
      }
    }

    // ----- COOLDOWN: re-learn feet reference then re-arm -----
    else if (state.phase === 'cooldown') {
      if (performance.now() > state.cooldownUntil) {
        // Quick re-calibration so landing stance doesn't break next jump
        state.phase = 'calibrating';
        state.feetRef = null;
        state.feetRefReady = false;
        state.calibSamples = 0;
        state.calibNeeded = 12; // faster re-calib between jumps
        setStatus('Stand still — re-arming…', '');
        $('#roi-hint').textContent = 'Feet back in the green zone';
      }
    }

    drawLiveOverlay(w, h, diff);
    requestAnimationFrame(liveLoop);
  }

  function finishLiveJump(t) {
    const heightM = heightFromFlight(t);
    state.lastHeightM = heightM;
    state.flightTime = t;
    state.phase = 'cooldown';
    state.cooldownUntil = performance.now() + 1200;
    state.emptyStreak = 0;
    state.presentStreak = 0;

    $('#live-flight').textContent = t.toFixed(3);
    $('#live-height').textContent = formatHeight(heightM);
    setStatus('LANDED  ' + formatHeight(heightM) + ' ' + heightUnit(), 'landed');
    $('#roi-hint').textContent = 'Nice jump — hold still to re-arm';

    beep(660, 0.12);
    setTimeout(() => beep(880, 0.1), 100);

    addJump(heightM, t, 'live');
  }

  function armLive() {
    if (!state.stream) return;

    // Toggle off
    if (state.armed && state.phase !== 'idle') {
      state.armed = false;
      state.phase = 'idle';
      state.feetRef = null;
      state.feetRefReady = false;
      state.calibSamples = 0;
      $('#arm-label').textContent = 'Arm Sensor';
      setStatus('Put feet in the green zone, then Arm', '');
      $('#roi-hint').textContent = 'Feet must stay inside the green zone while standing';
      return;
    }

    // Start calibration → then armed
    state.armed = true;
    state.phase = 'calibrating';
    state.feetRef = null;
    state.feetRefReady = false;
    state.calibSamples = 0;
    state.calibNeeded = 20;
    state.emptyStreak = 0;
    state.presentStreak = 0;
    state.flightTime = 0;
    $('#live-flight').textContent = '0.000';
    $('#live-height').textContent = '—';
    $('#arm-label').textContent = 'Disarm';
    setStatus('Hold still… calibrating feet 0%', '');
    $('#roi-hint').textContent = 'Stand still with both feet in the green zone';
    beep(520, 0.06);
  }

  // ========== VIDEO MODE ==========
  const analysisVideo = $('#analysis-video');
  const videoOverlay = $('#video-overlay');
  const videoCtx = videoOverlay.getContext('2d');

  function loadVideoFile(file) {
    if (!file) return;
    // Some mobile browsers leave file.type empty — still allow common extensions
    const okType = !file.type || file.type.startsWith('video/') ||
      /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(file.name || '');
    if (!okType) {
      alert('Please choose a video file (mp4, mov, webm…).');
      return;
    }

    // Revoke previous blob URL
    if (analysisVideo.src && analysisVideo.src.startsWith('blob:')) {
      try { URL.revokeObjectURL(analysisVideo.src); } catch (_) {}
    }

    const url = URL.createObjectURL(file);
    analysisVideo.pause();
    analysisVideo.removeAttribute('src');
    analysisVideo.load();
    analysisVideo.src = url;
    analysisVideo.muted = true;
    analysisVideo.playsInline = true;
    analysisVideo.setAttribute('playsinline', '');
    analysisVideo.setAttribute('webkit-playsinline', '');

    const onReady = () => {
      state.videoReady = true;
      state.duration = analysisVideo.duration || 0;
      state.takeoffT = null;
      state.landingT = null;
      state.videoFps = 30;
      estimateFps();

      $('#drop-zone').classList.add('hidden');
      $('#video-stage').classList.add('has-video');
      $('#timeline-panel').hidden = false;
      $('#scrubber').max = Math.max(1, Math.floor(state.duration * 1000));
      $('#scrubber').value = 0;
      $('#total-time').textContent = '/ ' + state.duration.toFixed(3) + 's';
      $('#vid-fps').textContent = state.videoFps.toFixed(1);
      $('#fps-input').value = String(state.videoFps);
      updateVideoMarks();

      // Force first frame to paint (fixes black screen on many browsers)
      const showFirstFrame = () => {
        try {
          analysisVideo.currentTime = 0.001;
        } catch (_) {
          analysisVideo.currentTime = 0;
        }
        // Brief play/pause can force decode on iOS
        const p = analysisVideo.play();
        if (p && p.then) {
          p.then(() => {
            analysisVideo.pause();
            analysisVideo.currentTime = 0;
            onVideoTimeUpdate();
          }).catch(() => {
            analysisVideo.currentTime = 0;
            onVideoTimeUpdate();
          });
        } else {
          analysisVideo.pause();
          onVideoTimeUpdate();
        }
      };

      if (analysisVideo.readyState >= 2) {
        showFirstFrame();
      } else {
        analysisVideo.addEventListener('loadeddata', showFirstFrame, { once: true });
      }
    };

    analysisVideo.addEventListener('loadedmetadata', onReady, { once: true });
    analysisVideo.addEventListener('error', () => {
      alert('Could not load this video. Try MP4 (H.264) or another format.');
      console.error('Video error', analysisVideo.error);
    }, { once: true });
  }

  function estimateFps() {
    state.videoFps = 30;
  }

  function getEffectiveFps() {
    const override = parseFloat($('#fps-input').value);
    if (override > 0 && override <= 240) return override;
    return state.videoFps || 30;
  }

  function seekTo(t) {
    if (!state.videoReady) return;
    const target = clamp(t, 0, state.duration || 0);
    try {
      analysisVideo.currentTime = target;
    } catch (_) {}
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
    if (analysisVideo.src && analysisVideo.src.startsWith('blob:')) {
      try { URL.revokeObjectURL(analysisVideo.src); } catch (_) {}
    }
    analysisVideo.removeAttribute('src');
    analysisVideo.load();
    state.videoReady = false;
    $('#drop-zone').classList.remove('hidden');
    $('#video-stage').classList.remove('has-video');
    $('#timeline-panel').hidden = true;
    showScreen('splash');
  });

  $('#btn-live-arm').addEventListener('click', armLive);

  $('#btn-live-reset').addEventListener('click', () => {
    state.flightTime = 0;
    state.emptyStreak = 0;
    state.presentStreak = 0;
    $('#live-flight').textContent = '0.000';
    $('#live-height').textContent = '—';
    if (state.armed) {
      // Re-run calibration
      state.phase = 'calibrating';
      state.feetRef = null;
      state.feetRefReady = false;
      state.calibSamples = 0;
      state.calibNeeded = 20;
      setStatus('Hold still… calibrating feet 0%', '');
      $('#roi-hint').textContent = 'Stand still with both feet in the green zone';
    } else {
      state.phase = 'idle';
      setStatus('Put feet in the green zone, then Arm', '');
    }
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

  function setUnit(u) {
    state.unit = u;
    const unitSel = $('#unit-pref');
    const vidUnitSel = $('#vid-unit-pref');
    if (unitSel) unitSel.value = u;
    if (vidUnitSel) vidUnitSel.value = u;
    updateSessionUI();
    updateVideoMarks();
    $('#live-height-unit').textContent = heightUnit();
    if (state.lastHeightM) {
      $('#live-height').textContent = formatHeight(state.lastHeightM);
    }
  }

  $('#unit-pref').addEventListener('change', (e) => setUnit(e.target.value));
  const vidUnit = $('#vid-unit-pref');
  if (vidUnit) {
    vidUnit.addEventListener('change', (e) => setUnit(e.target.value));
  }

  // Jump type: stationary vs dynamic
  document.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.armed && state.phase === 'airborne') return;
      applyJumpType(btn.dataset.type);
    });
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
  setUnit('imperial');
  applyJumpType('stationary');
  updateSessionUI();
  showScreen('splash');
})();
