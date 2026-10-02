const fs = require("node:fs");
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const passwordFile = process.env.TUNNEL_PASSWORD_FILE;
if (!passwordFile || !fs.existsSync(passwordFile)) {
  throw new Error("TUNNEL_PASSWORD_FILE must point to the private password file");
}

const password = fs.readFileSync(passwordFile, "utf8").trim();
if (!password) throw new Error("The tunnel password file is empty");

const expected = Buffer.from(`qwen:${password}`);
const origin = { hostname: "127.0.0.1", port: 3210 };

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let actual;
  try {
    actual = Buffer.from(header.slice(6), "base64");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function challenge(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Qwen Image Studio", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Password required");
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) return challenge(res);
  const headers = { ...req.headers, host: `127.0.0.1:${origin.port}` };
  const upstream = http.request({ ...origin, method: req.method, path: req.url, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Upstream unavailable");
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Qwen Image Studio\"\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = http.request({
    ...origin,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${origin.port}` },
  });
  upstream.on("upgrade", (res, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`);
    for (const [name, value] of Object.entries(res.headers)) socket.write(`${name}: ${value}\r\n`);
    socket.write("\r\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(3211, "127.0.0.1", () => {
  console.log("Password proxy listening on 127.0.0.1:3211");
});
