(() => {
  const button = document.getElementById('soundToggle');
  if (!button) return;
  const KEY = 'ai-world-sound-enabled';
  let preferred = localStorage.getItem(KEY) === 'true';
  let enabled = false;
  let context = null;
  let interval = null;
  let nextStepTime = 0;
  let step = 0;
  const cache = new Map();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const melody = [0, 4, 7, null, 9, 7, 4, null, 2, 4, 7, 11, 9, 7, 4, null];
  const bass = [0, null, 0, null, 5, null, 5, null, 7, null, 7, null, 5, null, 4, null];
  const base = 261.63;
  const stepSeconds = 60 / 116 / 2;

  function updateButton() {
    button.textContent = enabled ? '♫ 音乐开' : preferred ? '♫ 继续音乐' : '♫ 音乐关';
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? '关闭背景音乐和音效' : '开启背景音乐和音效');
  }
  function noteFrequency(semitone, octave = 0) { return base * Math.pow(2, (semitone + 12 * octave) / 12); }
  function sampleBuffer(frequency, duration, voice = 'lead') {
    const key = `${frequency}:${duration}:${voice}`;
    if (cache.has(key)) return cache.get(key);
    const length = Math.ceil(context.sampleRate * duration);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let noise = 17;
    for (let i = 0; i < length; i++) {
      const t = i / context.sampleRate;
      const phase = t * frequency % 1;
      const env = Math.pow(1 - i / length, voice === 'bass' ? 1.6 : 2.2) * Math.min(1, t * 95);
      let wave;
      if (voice === 'bass') wave = (phase < .5 ? .68 : -.68) + Math.sin(2 * Math.PI * phase) * .25;
      else if (voice === 'drum') { noise = (noise * 1664525 + 1013904223) >>> 0; wave = ((noise / 4294967295) * 2 - 1) * Math.pow(1 - i / length, 3); }
      else wave = (phase < .5 ? .52 : -.52) + Math.sin(2 * Math.PI * phase) * .21 + Math.sin(4 * Math.PI * phase) * .08;
      data[i] = Math.round(Math.max(-1, Math.min(1, wave * env)) * 32767) / 32767;
    }
    cache.set(key, buffer);
    return buffer;
  }
  function play(frequency, time, duration = .19, voice = 'lead', volume = .085) {
    if (!context || !enabled) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = sampleBuffer(frequency, duration, voice);
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start(time);
  }
  function tick() {
    if (!context || !enabled) return;
    const limit = context.currentTime + .25;
    while (nextStepTime < limit) {
      const n = step % 16;
      if (melody[n] != null) play(noteFrequency(melody[n]), nextStepTime, .23, 'lead', .065);
      if (bass[n] != null) play(noteFrequency(bass[n], -1), nextStepTime, .25, 'bass', .045);
      if (n % 4 === 0) play(75, nextStepTime, .09, 'drum', .025);
      step++;
      nextStepTime += stepSeconds;
    }
  }
  function effect(kind) {
    if (!context || !enabled) return;
    const at = context.currentTime + .008;
    if (kind === 'success') [0, 4, 7, 12].forEach((note, i) => play(noteFrequency(note, 1), at + i * .09, .2, 'lead', .105));
    else play(noteFrequency(7, 1), at, .09, 'lead', .07);
  }
  async function start() {
    if (!AudioContextClass) { button.textContent = '此设备无法播放'; button.disabled = true; return; }
    context ||= new AudioContextClass();
    await context.resume();
    enabled = true;
    preferred = true;
    localStorage.setItem(KEY, 'true');
    nextStepTime = context.currentTime + .04;
    step = 0;
    interval = setInterval(tick, 100);
    tick();
    updateButton();
  }
  function stop() {
    enabled = false;
    preferred = false;
    localStorage.setItem(KEY, 'false');
    if (interval) clearInterval(interval);
    interval = null;
    context?.suspend();
    updateButton();
  }
  button.addEventListener('click', async () => { if (enabled) stop(); else { try { await start(); effect('success'); } catch { button.textContent = '声音不可用'; } } });
  document.addEventListener('click', event => {
    if (!enabled || event.target.closest('#soundToggle')) return;
    if (event.target.closest('[data-target-record]')) effect('success');
    else if (event.target.closest('[data-view], [data-world], [data-world-index], [data-map-project], .world-card')) effect('click');
  });
  document.addEventListener('visibilitychange', () => { if (!context || !enabled) return; if (document.hidden) context.suspend(); else context.resume(); });
  updateButton();
})();
