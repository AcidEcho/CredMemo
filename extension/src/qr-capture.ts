import { fail } from './types.ts';

export async function captureDesktopFrame(signal: AbortSignal): Promise<HTMLCanvasElement> {
  const streamId = await new Promise<string>((resolve, reject) => {
    const cancel = () => { chrome.desktopCapture.cancelChooseDesktopMedia(requestId); reject(new DOMException('Cancelled', 'AbortError')); };
    const requestId = chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab'], id => {
      signal.removeEventListener('abort', cancel);
      if (chrome.runtime.lastError) { reject(new Error('screen_capture_failed')); return; }
      if (!id) { reject(new Error('screen_capture_cancelled')); return; }
      resolve(id);
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  const ownWindow = await chrome.windows.getCurrent();
  try {
    // 截图前收起扫码窗口，避免遮挡所选屏幕中的二维码。
    if (ownWindow.id !== undefined) await chrome.windows.update(ownWindow.id, { state: 'minimized' });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, maxWidth: 8192, maxHeight: 8192,
    } } as MediaTrackConstraints });
    return await frameFromStream(stream, signal);
  } finally {
    if (ownWindow.id !== undefined) {
      try { await chrome.windows.update(ownWindow.id, { state: ownWindow.state === 'maximized' ? 'maximized' : 'normal', focused: true }); } catch {}
    }
  }
}

export async function frameFromStream(stream: MediaStream, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  const stop = () => stream.getTracks().forEach(track => track.stop());
  signal.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frameId = 0;
  try {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    await video.play();
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('screen_capture_failed')), 5000);
      frameId = video.requestVideoFrameCallback(() => resolve());
    });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!video.videoWidth || !video.videoHeight) fail('screen_capture_failed');
    if (video.videoWidth * video.videoHeight > 32_000_000) fail('too_large');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) fail('screen_capture_failed');
    context.drawImage(video, 0, 0);
    return canvas;
  } finally {
    clearTimeout(timer); video.cancelVideoFrameCallback(frameId); stop(); video.pause(); video.srcObject = null;
    signal.removeEventListener('abort', stop);
  }
}
