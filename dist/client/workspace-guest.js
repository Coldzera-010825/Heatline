export function openGuestWorkspace() {
  const worker = new Worker(new URL("workspace-guest-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let nextId = 0, failure;

  function stop(error) {
    worker.terminate();
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  worker.onmessage = ({ data: { id, error, options, body } }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(new Response(body, options));
  };
  worker.onerror = () => stop(new Error("The guest workspace stopped. Reload to start a new session."));
  window.addEventListener("pagehide", () => stop(new Error("The guest session ended.")), { once: true });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });

  return (path, init) => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, path, init }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
}
