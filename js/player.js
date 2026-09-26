// Reference video: either a YouTube embed or a local video file, behind one clock API.

let ytApi = null;
function loadYouTubeApi() {
  ytApi ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Could not load YouTube'));
    document.head.appendChild(s);
  });
  return ytApi;
}

export function parseYouTubeId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || String(url).match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

export class RefPlayer {
  constructor({ ytHost, ytWrap, video, note }) {
    Object.assign(this, { ytHost, ytWrap, video, note });
    this.kind = null; this.yt = null; this.ytId = null;
    this._last = { t: 0, at: 0 };
    this.onError = null;
  }

  async useYouTube(id, start = 0) {
    this.kind = 'yt';
    this.video.pause(); this.video.style.display = 'none'; this.ytWrap.style.display = '';
    const YT = await loadYouTubeApi();
    if (this.yt && this.ytId === id) { this.yt.seekTo(start, true); this.yt.pauseVideo(); return; }
    this.ytId = id;
    if (this.yt) { this.yt.cueVideoById({ videoId: id, startSeconds: start }); return; }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 8000); // don't block the game if YouTube is slow
      this.yt = new YT.Player(this.ytHost, {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(start), controls: 1, origin: location.origin },
        events: {
          onReady: () => { clearTimeout(timeout); resolve(); },
          onError: (e) => this.onError?.(e.data),
        },
      });
    });
  }

  useFile(url) {
    this.kind = 'file';
    this.yt?.pauseVideo?.();
    this.ytWrap.style.display = 'none';
    this.video.style.display = 'block';
    if (this.video.src !== url) this.video.src = url;
  }

  none() {
    this.kind = null;
    this.yt?.pauseVideo?.(); this.video.pause();
  }

  play() {
    if (this.kind === 'yt') this.yt?.playVideo?.();
    else if (this.kind === 'file') this.video.play().catch((e) => this.onError?.(e.message));
  }
  pause() {
    if (this.kind === 'yt') this.yt?.pauseVideo?.();
    else if (this.kind === 'file') this.video.pause();
  }
  seek(t) {
    if (this.kind === 'yt') this.yt?.seekTo?.(t, true);
    else if (this.kind === 'file') this.video.currentTime = t;
    this._last = { t, at: performance.now() };
  }
  setMuted(m) {
    if (this.kind === 'yt') m ? this.yt?.mute?.() : this.yt?.unMute?.();
    this.video.muted = m;
  }
  get playing() {
    if (this.kind === 'yt') return this.yt?.getPlayerState?.() === 1;
    if (this.kind === 'file') return !this.video.paused && !this.video.ended;
    return false;
  }
  get ended() {
    if (this.kind === 'yt') return this.yt?.getPlayerState?.() === 0;
    return this.kind === 'file' && this.video.ended;
  }
  /** Current media time. YouTube reports coarse steps, so interpolate between them. */
  get time() {
    if (this.kind === 'file') return this.video.currentTime;
    if (this.kind === 'yt' && this.yt?.getCurrentTime) {
      const t = this.yt.getCurrentTime(), now = performance.now();
      if (t !== this._last.t) this._last = { t, at: now };
      return this.playing ? t + Math.min(0.5, (now - this._last.at) / 1000) : t;
    }
    return 0;
  }
}
