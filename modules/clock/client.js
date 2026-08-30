/* Clock — the reference ProdDash module. Client-only: no server entry.
   Everything a module may do is shown here: render inside root, read
   instanceSettings, report status, clean up in stop(). */

export default function create({ root, moduleApi }) {
  let timer = null;
  let timeEl = null;
  let dateEl = null;
  let resizeObserver = null;

  function settings() {
    return moduleApi.instanceSettings; // shell merges schema defaults for us
  }

  function renderFrame() {
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'clock-wrap';
    timeEl = document.createElement('div');
    timeEl.className = 'clock-time';
    dateEl = document.createElement('div');
    dateEl.className = 'clock-date';
    wrap.append(timeEl, dateEl);
    root.appendChild(wrap);
  }

  function tick() {
    const { format, showSeconds, showDate } = settings();
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], {
      hour12: format === '12h',
      hour: format === '12h' ? 'numeric' : '2-digit',
      minute: '2-digit',
      ...(showSeconds ? { second: '2-digit' } : {}),
    });
    dateEl.hidden = !showDate;
    if (showDate) {
      dateEl.textContent = now.toLocaleDateString([], {
        weekday: 'long', month: 'long', day: 'numeric',
      });
    }
  }

  /** Scale the digits to the tile (CSS alone can't see the tile's box). */
  function fit() {
    const { showSeconds, showDate } = settings();
    const chars = (showSeconds ? 8 : 5) + 1;
    const size = Math.min((root.clientWidth * 1.7) / chars, root.clientHeight * (showDate ? 0.42 : 0.55));
    timeEl.style.fontSize = Math.max(12, Math.floor(size)) + 'px';
    dateEl.style.fontSize = Math.max(10, Math.floor(size * 0.28)) + 'px';
  }

  return {
    start() {
      renderFrame();
      tick();
      fit();
      timer = setInterval(tick, 250);
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(root);
      moduleApi.setStatus('ok', 'Ticking');
    },
    stop() {
      clearInterval(timer);
      timer = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      root.innerHTML = '';
    },
    onResize() {
      fit();
    },
  };
}
