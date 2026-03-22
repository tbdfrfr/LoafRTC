(function () {
  'use strict';

  const ui = {
    roomCode: document.getElementById('room-code'),
    status: document.getElementById('status'),
    peerCount: document.getElementById('peer-count'),
    message: document.getElementById('message'),

    resolution: document.getElementById('setting-resolution'),
    fps: document.getElementById('setting-fps'),
    bitrate: document.getElementById('setting-bitrate'),
    codec: document.getElementById('setting-codec'),

    statFps: document.getElementById('stat-fps'),
    statBitrate: document.getElementById('stat-bitrate'),
    statEncode: document.getElementById('stat-encode'),
    statRtt: document.getElementById('stat-rtt'),

    copyButton: document.getElementById('copy-code'),
    disconnectButton: document.getElementById('disconnect'),
    keyframeButton: document.getElementById('request-keyframe'),
    openSignalingButton: document.getElementById('open-signaling'),
  };

  let clearMessageTimer = null;

  function showMessage(text, isError) {
    ui.message.textContent = text;
    ui.message.classList.toggle('error', Boolean(isError));

    if (clearMessageTimer) {
      clearTimeout(clearMessageTimer);
    }

    clearMessageTimer = setTimeout(() => {
      ui.message.textContent = '';
      ui.message.classList.remove('error');
    }, 3000);
  }

  function applySettings(settings) {
    ui.resolution.value = String(settings.resolution || '1080p');
    ui.fps.value = String(settings.fps || 60);
    ui.bitrate.value = String(settings.bitrateMbps || 20);
    ui.codec.value = String(settings.codec || 'auto');
  }

  function applyStats(stats) {
    ui.statFps.textContent = String(Number(stats.fpsSent || 0).toFixed(0));
    ui.statBitrate.textContent = `${Number(stats.bitrateMbps || 0).toFixed(2)} Mbps`;
    ui.statEncode.textContent = `${Number(stats.encodeMs || 0).toFixed(1)} ms`;
    ui.statRtt.textContent = `${Number(stats.rttMs || 0).toFixed(0)} ms`;
  }

  function applyState(state) {
    ui.roomCode.textContent = state.roomCode || '------';
    ui.status.textContent = state.status || 'Disconnected';
    ui.peerCount.textContent = `Viewers: ${Number(state.peerCount || 0)}`;

    applySettings(state.settings || {});
    applyStats(state.stats || {});
  }

  async function pushSettings() {
    const patch = {
      resolution: ui.resolution.value,
      fps: Number(ui.fps.value),
      bitrateMbps: Number(ui.bitrate.value),
      codec: ui.codec.value,
      audioEnabled: false,
    };

    try {
      await window.loafHost.updateSettings(patch);
      showMessage('Settings updated');
    } catch (err) {
      showMessage(err.message || 'Failed to update settings', true);
    }
  }

  function bindEvents() {
    ui.resolution.addEventListener('change', pushSettings);
    ui.fps.addEventListener('change', pushSettings);
    ui.bitrate.addEventListener('change', pushSettings);
    ui.codec.addEventListener('change', pushSettings);

    ui.copyButton.addEventListener('click', async () => {
      const copied = await window.loafHost.copyRoomCode();
      showMessage(copied ? 'Code copied' : 'No active room code', !copied);
    });

    ui.disconnectButton.addEventListener('click', async () => {
      await window.loafHost.disconnect();
      showMessage('Disconnected viewers');
    });

    ui.keyframeButton.addEventListener('click', async () => {
      const ok = await window.loafHost.forceKeyframe();
      showMessage(ok ? 'Keyframe requested' : 'Keyframe request failed', !ok);
    });

    ui.openSignalingButton.addEventListener('click', async () => {
      await window.loafHost.openSignalingUrl();
    });
  }

  async function initialize() {
    bindEvents();

    const state = await window.loafHost.getState();
    applyState(state);

    window.loafHost.onState((next) => {
      applyState(next);
    });

    window.loafHost.onStats((stats) => {
      applyStats(stats);
    });

    window.loafHost.onError((err) => {
      showMessage(err.message || 'Host error', true);
    });

    window.loafHost.onUpdateDownloaded(() => {
      showMessage('Update downloaded. Restart app to apply.');
    });
  }

  initialize().catch((err) => {
    showMessage(err.message || 'Failed to initialize host renderer', true);
  });
})();
