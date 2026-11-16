import { localWorkspace } from "../local-workspace-storage.mjs";
import { answerPlatformQuestion } from "./platform-answer.mjs";
import { workspaceData } from "./workspace.mjs";

const assets = {
  fetch(request) {
    const url = new URL(request.url);
    const publicAsset = url.pathname === "/build-info.json" || url.pathname === "/data/admin/catalog.json" ||
      /^\/data\/admin\/fua\/[\w-]+\/boundary\.json$/.test(url.pathname);
    if (url.origin !== self.location.origin || !publicAsset || url.search) return new Response(null, { status: 404 });
    return fetch(url, { credentials: "omit", redirect: "error" });
  },
};
const guest = { bucket: localWorkspace(), owner: "guest", assets };

self.onmessage = async ({ data: { id, path, init } }) => {
  try {
    const url = new URL("/api/workspace" + path, self.location.origin);
    const request = new Request(url, init);
    let response;
    if (url.pathname === "/api/workspace/methods" && request.method === "POST") {
      const { message } = await request.json();
      const info = await answerPlatformQuestion(message.slice(0, 400));
      response = Response.json({ ok: true, reply: info.reply });
    } else response = await workspaceData(request, url, guest);
    const options = { status: response.status, headers: [...response.headers] };
    if (response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      try {
        self.postMessage({ id, options, body: response.body }, [response.body]);
        return;
      } catch (error) {
        if (error.name !== "DataCloneError") throw error;
      }
    }
    self.postMessage({ id, options, body: await response.blob() });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
