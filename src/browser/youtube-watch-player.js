"use strict";

const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

function watchVideo(raw) {
  try {
    const url = new URL(raw);
    const videoId = url.searchParams.get("v");
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !WATCH_HOSTS.has(url.hostname) || url.pathname !== "/watch"
      || !/^[\w-]{11}$/.test(videoId || "")) return null;
    const start = url.searchParams.get("start") || url.searchParams.get("t") || "";
    const time = /^(?:(\d{1,4})h)?(?:(\d{1,4})m)?(?:(\d{1,5})s)?$/i.exec(start);
    const seconds = /^\d{1,5}$/.test(start) ? Number(start)
      : time ? Number(time[1] || 0) * 3600 + Number(time[2] || 0) * 60 + Number(time[3] || 0) : 0;
    return { videoId, start: Math.min(seconds, 86400) };
  } catch { return null; }
}

// Serialized into the existing Fast Proxy runtime. Keep dependencies explicit.
function installWatchPlayer(video, directElements) {
  const slots = [
    "ytd-watch-flexy #player-container-inner", "ytd-watch-flexy #player-container",
    "ytd-watch-flexy #player", "ytm-watch #player-container", "ytm-watch #player"
  ];
  const watch = new URL("https://www.youtube.com/watch");
  watch.searchParams.set("v", video.videoId);
  if (video.start) watch.searchParams.set("t", String(video.start));
  let cleanup = () => {};
  let observer, timeout;
  const stop = () => { observer?.disconnect(); clearTimeout(timeout); cleanup(); };

  function mount() {
    const slot = slots.map(selector => document.querySelector(selector)).find(el => el?.childElementCount);
    if (!slot) return false;
    observer?.disconnect();
    clearTimeout(timeout);

    const style = document.createElement("style");
    style.textContent = `
      [data-veyra-watch-slot] > :not([data-veyra-watch-player]){display:none!important}
      [data-veyra-watch-media]{width:100%;min-height:200px;aspect-ratio:16/9;display:grid;place-items:center;
        box-sizing:border-box;background:#0f0f0f;color:#fff;font:400 14px/1.5 system-ui,sans-serif}
      [data-veyra-watch-player] iframe{display:block;width:100%;height:100%;min-height:200px;border:0}
      [data-veyra-watch-prompt]{text-align:center;padding:12px;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}
      [data-veyra-watch-player] p{margin:6px 0 10px;color:#ddd}
      [data-veyra-watch-player] button{font:inherit;margin:4px}
      [data-veyra-watch-player] > a{display:block;width:fit-content;padding:4px 8px;color:#fff;background:#171717;
        font:400 14px/1.4 system-ui,sans-serif;text-decoration:underline}
      [data-veyra-watch-player] button{padding:8px 16px;color:#111;background:#fff;border:0;border-radius:20px;cursor:pointer}
      [data-veyra-watch-player] button:disabled{opacity:.65;cursor:default}
    `;
    document.head.append(style);
    const panel = document.createElement("section");
    panel.dataset.veyraWatchPlayer = "";
    panel.setAttribute("aria-label", "YouTube video");
    const media = document.createElement("div");
    media.dataset.veyraWatchMedia = "";
    const prompt = document.createElement("div");
    prompt.dataset.veyraWatchPrompt = "";
    const message = document.createElement("p");
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load YouTube player";
    const link = document.createElement("a");
    link.href = watch.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.referrerPolicy = "no-referrer";
    link.textContent = "Open on YouTube";
    directElements.add(link);
    prompt.append(load, message);
    media.append(prompt);
    panel.append(media, link);
    slot.dataset.veyraWatchSlot = "";
    slot.append(panel);
    const pauseNative = event => {
      if (event.target instanceof HTMLMediaElement && !panel.contains(event.target)) event.target.pause();
    };
    slot.addEventListener("play", pauseNative, true);
    for (const media of slot.querySelectorAll("video,audio")) if (!media.paused) media.pause();
    let frame = null;
    const update = () => {
      load.disabled = media.clientWidth < 200;
      message.textContent = load.disabled ? "Widen this pane to play here." : "Playback connects directly to YouTube.";
      if (load.disabled && frame) { frame = null; media.replaceChildren(prompt); }
    };
    load.addEventListener("click", event => {
      if (!event.isTrusted || frame || !panel.isConnected || media.clientWidth < 200) return;
      const embed = new URL("https://www.youtube-nocookie.com/embed/" + video.videoId);
      embed.searchParams.set("playsinline", "1");
      if (video.start) embed.searchParams.set("start", String(video.start));
      // The proxy patches document.createElement. Use the native method and
      // register just this element with the runtime, not a hostname allowlist.
      frame = Document.prototype.createElement.call(document, "iframe");
      directElements.add(frame);
      frame.title = "Official YouTube video player";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.allow = "encrypted-media; fullscreen; picture-in-picture";
      frame.allowFullscreen = true;
      frame.src = embed.href;
      media.replaceChildren(frame);
    });
    const resize = new ResizeObserver(update);
    resize.observe(media);
    update();
    cleanup = () => {
      resize.disconnect();
      slot.removeEventListener("play", pauseNative, true);
      delete slot.dataset.veyraWatchSlot;
      panel.remove();
      style.remove();
    };
    return true;
  }

  function start() {
    if (mount()) return;
    observer = new MutationObserver(() => mount());
    observer.observe(document.body, { childList: true, subtree: true });
    timeout = setTimeout(() => observer.disconnect(), 10_000);
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  addEventListener("pagehide", stop, { once: true });
  return next => {
    try {
      const url = new URL(next, watch);
      if (url.protocol === "https:" && url.pathname === "/watch" && url.searchParams.get("v") === video.videoId
        && ["www.youtube.com", "m.youtube.com", "youtube.com"].includes(url.hostname)) return;
    } catch {}
    removeEventListener("DOMContentLoaded", start);
    stop();
  };
}

module.exports = { watchVideo, installWatchPlayer };
